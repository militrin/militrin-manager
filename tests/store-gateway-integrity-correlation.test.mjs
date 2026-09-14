import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  financialDivergencePanelCopy,
  mapFinancialDivergenceRow,
} from '../src/lib/integrity/financial-divergence.ts';
import { parseAsaasWebhookPayload } from '../src/lib/payments/asaas-provider.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('PAYMENT_RECEIVED e PAYMENT_CONFIRMED correlacionam store_order sem emitir ticket', async () => {
  const sql = await read('supabase/migrations/20261026000000_operational_integrity_holder_store_finance.sql');
  const webhook = await read('src/app/api/webhooks/asaas/route.ts');
  const applyStart = sql.indexOf('create or replace function public.apply_store_order_gateway_status');
  const applyEnd = sql.indexOf('comment on function public.apply_store_order_gateway_status');
  const apply = sql.slice(applyStart, applyEnd);

  assert.match(apply, /where gateway_payment_id = p_provider_payment_id/);
  assert.match(apply, /p_external_reference/);
  assert.match(apply, /where order_number = v_ext/);
  assert.match(apply, /store_order_payment_confirmed/);
  assert.match(apply, /update public\.store_order_items set status = 'confirmed'/);
  assert.doesNotMatch(apply, /issue_ticket|confirm_order_payment_and_issue_tickets|insert into public\.tickets/);
  assert.match(apply, /if v_order\.status = 'confirmed' or v_order\.payment_status = 'paid' then/);
  assert.match(webhook, /p_external_reference: event\.externalReference/);
  assert.match(webhook, /apply_store_order_gateway_status/);
  assert.doesNotMatch(webhook, /admin_issue_tickets_for_paid_order|confirm_order_payment_and_issue_tickets/);
});

test('webhook Asaas expoe externalReference do pagamento da Loja', () => {
  const received = parseAsaasWebhookPayload(JSON.stringify({
    id: 'evt_store_received',
    event: 'PAYMENT_RECEIVED',
    payment: {
      id: 'pay_floiprsi88h04zus',
      status: 'RECEIVED',
      value: 60,
      externalReference: '57c7b892-1de8-470f-8012-dfcfdc48e9c9',
    },
  }));
  assert.equal(received.providerPaymentId, 'pay_floiprsi88h04zus');
  assert.equal(received.status, 'paid');
  assert.equal(received.externalReference, '57c7b892-1de8-470f-8012-dfcfdc48e9c9');

  const confirmed = parseAsaasWebhookPayload(JSON.stringify({
    id: 'evt_store_confirmed',
    event: 'PAYMENT_CONFIRMED',
    payment: {
      id: 'pay_floiprsi88h04zus',
      status: 'CONFIRMED',
      value: 60,
      externalReference: '57c7b892-1de8-470f-8012-dfcfdc48e9c9',
    },
  }));
  assert.equal(confirmed.status, 'paid');
  assert.equal(confirmed.eventType, 'PAYMENT_CONFIRMED');
  assert.equal(confirmed.externalReference, '57c7b892-1de8-470f-8012-dfcfdc48e9c9');
});

test('refund processado posterior nao aparece como divergencia financeira aberta', async () => {
  const sql = await read('supabase/migrations/20261026000000_operational_integrity_holder_store_finance.sql');
  const listStart = sql.indexOf('create or replace function public.list_gateway_financial_divergences');
  const list = sql.slice(listStart);

  assert.match(list, /processing_status = 'financial_divergence'/);
  assert.match(list, /later\.processing_status = 'processed'/);
  assert.match(list, /'PAYMENT_REFUNDED'/);
  assert.match(list, /so\.payment_status in \('paid', 'refunded'\)/);
  assert.match(list, /Pagamento da Loja aguardando reconciliação/);
  assert.match(list, /correlation_kind/);
  assert.doesNotMatch(list, /update public\.payment_gateway_events/);
  assert.doesNotMatch(list, /delete from public\.payment_gateway_events/);
});

test('PIX Loja nao pago expira pelo prazo comercial; pago nao e expirado depois', async () => {
  const sql = await read('supabase/migrations/20261026000000_operational_integrity_holder_store_finance.sql');
  const expireStart = sql.indexOf('create or replace function public.expire_expired_store_orders');
  const expireEnd = sql.indexOf('revoke all on function public.expire_expired_store_orders');
  const expire = sql.slice(expireStart, expireEnd);
  const startPix = sql.slice(
    sql.indexOf('create or replace function public.start_store_order_payment_pix'),
    sql.indexOf('-- 4. Webhook Loja'),
  );

  assert.match(expire, /pix_commercial_expires_at/);
  assert.match(expire, /PAYMENT_RECEIVED/);
  assert.match(expire, /PAYMENT_CONFIRMED/);
  assert.match(expire, /status = 'pending'/);
  assert.match(expire, /payment_status = 'pending'/);
  const storeActions = await read('src/lib/store/actions.ts');
  assert.match(storeActions, /resolvePixCommercialExpiresAt/);
});

test('painel: divergencia Loja correlacionavel tem copy correta e eixs separados', async () => {
  const panel = await read('src/app/painel/integridade/gateway-financial-divergences-panel.tsx');
  const center = await read('src/app/painel/integridade/integrity-center.tsx');
  const page = await read('src/app/painel/integridade/page.tsx');
  const entity = await read('src/app/painel/integridade/entity-card.tsx');

  assert.match(center, /Integridade estrutural/);
  assert.match(center, /Nenhum problema estrutural detectado/);
  assert.match(panel, /Gateway \/ Financeiro/);
  assert.match(page, /Gateway \/ Financeiro/);
  assert.match(entity, /operational_holder_name/);
  assert.match(entity, /residual_contact_name/);
  assert.doesNotMatch(entity, /Titular atual/);

  const storeRow = mapFinancialDivergenceRow({
    id: '11111111-1111-4111-8111-111111111111',
    provider: 'asaas',
    provider_payment_id: 'pay_floiprsi88h04zus',
    event_type: 'PAYMENT_RECEIVED',
    received_at: '2026-09-11T21:22:12Z',
    last_error: 'ORPHAN_CHARGE',
    correlation_kind: 'store_order',
    store_order_id: '57c7b892-1de8-470f-8012-dfcfdc48e9c9',
    store_order_number: 'LOJA-20260911-dc2de760',
    store_order_status: 'pending',
    store_payment_status: 'pending',
    customer_name: 'Cleison',
    amount: 60,
    action_href: '/loja/pedidos/57c7b892-1de8-470f-8012-dfcfdc48e9c9',
    title: 'Pagamento da Loja aguardando reconciliação',
  });
  assert.equal(storeRow.correlation_kind, 'store_order');
  assert.equal(storeRow.title, 'Pagamento da Loja aguardando reconciliação');
  assert.equal(storeRow.action_href, '/loja/pedidos/57c7b892-1de8-470f-8012-dfcfdc48e9c9');
  assert.doesNotMatch(storeRow.title, /sem vínculo local/);

  const copy = financialDivergencePanelCopy(1);
  assert.equal(copy.heading, 'Gateway / Financeiro');
  assert.match(copy.openLabel, /1 divergência financeira aberta/);
  assert.match(copy.description, /independentes das verificações estruturais/);
  assert.equal(financialDivergencePanelCopy(0).openLabel, '0 divergências financeiras abertas');
});
