import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isReusableLiveGatewayCharge, isReusableLivePix } from '../src/lib/checkout/pix-payment-status.ts';
import { isCommercialPaymentWindowOpen, pixDueDateEndOfDay, resolvePixCommercialExpiresAt } from '../src/lib/payments/pix-due-date.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('expire_stale reusa o cron existente e seleciona pelo prazo comercial do PIX', async () => {
  const sql = await read('supabase/migrations/20261025000000_pix_commercial_expire_stale.sql');
  assert.match(sql, /create or replace function public\.pix_commercial_expires_at/);
  assert.match(sql, /create or replace function public\.expire_stale_order_payments/);
  assert.match(sql, /public\.pix_commercial_expires_at\(p\.payment_method, p\.expires_at, p\.created_at\) <= now\(\)/);
  assert.match(sql, /_apply_terminal_order_payment_status\(v_payment_id, 'expired'\)/);
  assert.doesNotMatch(sql, /cancelPayment/);
  assert.match(sql, /America\/Sao_Paulo/);
  assert.match(sql, /interval '30 days'/);
});

test('claim e start_order_payment_pix nao geram cobranca nova apos o prazo comercial', async () => {
  const sql = await read('supabase/migrations/20261025000000_pix_commercial_expire_stale.sql');
  assert.match(sql, /v_commercial := public\.pix_commercial_expires_at/);
  assert.match(sql, /Prazo comercial do pagamento expirado/);
  assert.match(sql, /Pagamento nao pode mais ser reiniciado/);
  assert.match(sql, /Pagamento nao pode mais ser gerado/);
  assert.match(sql, /Pedido nao esta mais no carrinho/);
});

test('pagamento tardio apos expired registra dinheiro e NAO emite ingresso nem reabre pedido', async () => {
  const sql = await read('supabase/migrations/20261008000000_administrative_asaas_refund.sql');
  const paidBlock = sql.slice(sql.lastIndexOf("if p_internal_status = 'paid' then"));
  assert.match(paidBlock, /payment_status = 'paid'/);
  assert.match(paidBlock, /payment_paid_after_'||v_previous/);
  assert.match(paidBlock, /needs_manual_reconciliation',true/);
  const latePay = paidBlock.slice(paidBlock.indexOf("if v_previous <> 'pending' then"));
  const lateReturn = latePay.indexOf('return;');
  const issueCall = latePay.indexOf('confirm_order_payment_and_issue_tickets');
  assert.ok(lateReturn >= 0, 'late pay deve retornar sem seguir o fluxo normal');
  assert.ok(issueCall < 0 || issueCall > lateReturn, 'confirm_order_payment_and_issue_tickets nao pode rodar no paid_after_expired');
  assert.doesNotMatch(latePay.slice(0, lateReturn), /update public\.orders set status = 'confirmed'/);
  assert.doesNotMatch(latePay.slice(0, lateReturn), /reservation_status = 'pending'/);
  assert.doesNotMatch(latePay.slice(0, lateReturn), /status = 'reserved'/);
});

test('expire_stale so pega pending e nao revive expired/cancelled/refunded/paid', async () => {
  const sql = await read('supabase/migrations/20261025000000_pix_commercial_expire_stale.sql');
  const start = sql.indexOf('create or replace function public.expire_stale_order_payments');
  const end = sql.indexOf('create or replace function public.start_order_payment_pix');
  const expireFn = sql.slice(start, end);
  assert.match(expireFn, /p\.payment_status = 'pending'/);
  assert.match(expireFn, /_apply_terminal_order_payment_status\(v_payment_id, 'expired'\)/);
  assert.doesNotMatch(expireFn, /payment_status in \('expired'/);
  assert.doesNotMatch(expireFn, /update public\.orders set status = 'pending'/);
  assert.doesNotMatch(expireFn, /payment_status = 'paid'/);
});

test('_apply_terminal continua liberando reserva ao expirar', async () => {
  const sql = await read('supabase/migrations/20261008000000_administrative_asaas_refund.sql');
  assert.match(sql, /reservation_expires_at = null/);
  assert.match(sql, /status = p_target_status/);
  assert.match(sql, /reservation_status = 'expired'/);
  assert.match(sql, /release_store_item_reservation/);
});

test('QR futuro do Asaas nao mantem PIX reutilizavel depois do dueDate', () => {
  const now = new Date('2026-09-13T15:00:00.000Z');
  const payment = {
    payment_status: 'pending',
    pix_code: '00020126',
    gateway_payment_id: 'pay_ebwhcnxqc81ehrq0',
    expires_at: '2027-09-11T23:59:59.000Z',
    created_at: '2026-09-11T23:54:07.893Z',
    payment_method: 'pix',
    gateway_charge_reusable: true,
    now,
  };
  assert.equal(isReusableLivePix(payment), false);
  assert.equal(isReusableLiveGatewayCharge(payment), false);
  assert.equal(isCommercialPaymentWindowOpen({
    expiresAt: payment.expires_at,
    paymentCreatedAt: payment.created_at,
    paymentMethod: 'pix',
    now,
  }), false);
});

test('PIX ainda dentro do dueDate continua reutilizavel', () => {
  const now = new Date('2026-09-11T21:00:00.000Z');
  const expiresAt = pixDueDateEndOfDay('2026-09-11');
  const payment = {
    payment_status: 'pending',
    pix_code: '00020126',
    gateway_payment_id: 'pay_live',
    expires_at: expiresAt,
    created_at: '2026-09-11T12:00:00.000Z',
    payment_method: 'pix',
    gateway_charge_reusable: true,
    now,
  };
  assert.equal(isReusableLivePix(payment), true);
  assert.equal(isReusableLiveGatewayCharge(payment), true);
  assert.equal(resolvePixCommercialExpiresAt({
    expiresAt,
    paymentCreatedAt: payment.created_at,
    paymentMethod: 'pix',
  }), expiresAt);
});

test('pago, cancelado e estornado nunca reabrem cobranca viva', () => {
  const now = new Date('2026-09-11T21:00:00.000Z');
  const future = pixDueDateEndOfDay('2026-09-11');
  const base = {
    pix_code: '00020126',
    gateway_payment_id: 'pay_1',
    expires_at: future,
    created_at: '2026-09-11T12:00:00.000Z',
    payment_method: 'pix',
    gateway_charge_reusable: true,
    now,
  };
  assert.equal(isReusableLiveGatewayCharge({ ...base, payment_status: 'paid' }), false);
  assert.equal(isReusableLiveGatewayCharge({ ...base, payment_status: 'cancelled' }), false);
  assert.equal(isReusableLiveGatewayCharge({ ...base, payment_status: 'refunded' }), false);
  assert.equal(isReusableLiveGatewayCharge({ ...base, payment_status: 'expired' }), false);
});

test('Home, Compras e detalhe usam a mesma regra comercial do PIX', async () => {
  const home = await read('src/app/minha-conta/page.tsx');
  const compras = await read('src/app/minha-conta/compras/page.tsx');
  const detalhe = await read('src/app/minha-conta/compras/[orderId]/page.tsx');
  const portal = await read('src/lib/account/portal-orders-and-tickets.ts');
  const pixAction = await read('src/app/inscricao/actions.ts');
  assert.match(home, /findActionableAccountOrder\(orders\)/);
  assert.match(compras, /resolveAccountOrderStatus\(order\)/);
  assert.match(compras, /resolvePixCommercialExpiresAt/);
  assert.match(detalhe, /resolvePixCommercialExpiresAt/);
  assert.match(detalhe, /canContinueCommercialPayment\(commercialStatus\)/);
  assert.match(portal, /resolvePixCommercialExpiresAt/);
  assert.match(pixAction, /closedCommercialPaymentMessage/);
  assert.match(pixAction, /isCommercialPaymentWindowOpen/);
  assert.doesNotMatch(home, /Nenhuma compra pendente no momento/);
});
