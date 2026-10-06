import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(path) {
  return (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
}

test('20261126: expire_stale e claim incluem cartao no mesmo hold curto', async () => {
  const sql = await read('../supabase/migrations/20261126000000_unified_10min_card_checkout_hold.sql');
  assert.match(sql, /in \('pix', 'credit_card'\)/);
  assert.match(sql, /pending_cancel_provider_payment_id/);
  assert.match(sql, /claim_expired_pix_cancellations/);
  assert.doesNotMatch(sql, /_apply_terminal_order_payment_status\(v_payment\.id, 'expired'\)[\s\S]*v_needs_gateway :=/);
  assert.match(sql, /NAO aplicar em producao sem GO/);
});

test('createCardPayment PIX/cartao usam o mesmo lease de 10 min', async () => {
  const asaas = await read('../src/lib/payments/asaas-provider.ts');
  const fake = await read('../src/lib/payments/fake-gateway-provider.ts');
  const hold = await read('../src/lib/payments/checkout-hold.ts');
  const persist = await read('../src/app/inscricao/actions.ts');
  const sql24 = await read('../supabase/migrations/20261124000000_unified_10min_pix_stock_hold.sql');
  assert.match(hold, /CHECKOUT_STOCK_HOLD_MINUTES = 10/);
  const cardFn = asaas.slice(asaas.indexOf('async createCardPayment'));
  assert.match(cardFn, /expiresAt: checkoutHoldExpiresAtIso\(\)/);
  assert.doesNotMatch(cardFn, /23:59:59/);
  assert.doesNotMatch(cardFn, /60 \* 60 \* 1000/);
  assert.match(fake, /async createCardPayment[\s\S]*expiresAt: checkoutHoldExpiresAtIso\(\)/);
  assert.match(sql24, /v_hold := now\(\) \+ interval '10 minutes'/);
  assert.match(sql24, /expires_at = v_hold/);
  const persistCard = persist.slice(persist.indexOf('async function persistOrderCardCharge'));
  assert.match(persistCard, /p_expires_at: input\.payload\.expiresAt/);
  assert.match(persistCard, /start_order_payment_pix/);
});

test('complete_expired_pix_cancellation e method-agnostic', async () => {
  const sql24 = await read('../supabase/migrations/20261124000000_unified_10min_pix_stock_hold.sql');
  const sql26 = await read('../supabase/migrations/20261126000000_unified_10min_card_checkout_hold.sql');
  const complete = sql24.slice(
    sql24.indexOf('create or replace function public.complete_expired_pix_cancellation'),
    sql24.indexOf('create or replace function public.fail_expired_pix_cancellation'),
  );
  assert.match(complete, /_apply_terminal_order_payment_status\(p_payment_id, 'expired'\)/);
  assert.doesNotMatch(complete, /payment_method/);
  assert.doesNotMatch(complete, /pix_code/);
  assert.match(complete, /already_paid/);
  assert.match(complete, /if v_payment\.payment_status = 'paid'/);
  const apply = sql24.includes("create or replace function public._apply_terminal_order_payment_status")
    ? sql24
    : await read('../supabase/migrations/20261123000000_protect_issued_participant_and_paid_after_expired.sql');
  const applyFn = apply.slice(
    apply.indexOf('create or replace function public._apply_terminal_order_payment_status'),
    apply.indexOf('create or replace function public.start_order_payment_pix'),
  );
  assert.doesNotMatch(applyFn, /pix_code/);
  assert.doesNotMatch(applyFn, /payment_method/);
  assert.match(sql26, /Method-agnostic \(PIX e cartao\)/);
});

test('worker unico PIX+cartao: cartao cancela todas as charges antes de terminalizar', async () => {
  const worker = await read('../src/lib/payments/expire-and-cancel-stale.ts');
  const route = await read('../src/app/api/internal/expire-payments/route.ts');
  const lib = await read('../src/lib/payments/cancel-card-installment-charges.ts');
  assert.match(worker, /expireAndCancelStaleCheckoutPayments/);
  assert.match(worker, /cancelCardInstallmentCharges/);
  assert.match(worker, /credit_card/);
  assert.match(worker, /paid\?\.amount/);
  assert.match(worker, /confirmPaidAndClearLease/);
  assert.match(lib, /expectedChargeIds\?:/);
  assert.match(lib, /TODAS as charges/);
  assert.match(route, /expireAndCancelStaleCheckoutPayments/);
});

test('worker novo so age sobre linhas do claim; sem scan independente de cartao', async () => {
  const worker = await read('../src/lib/payments/expire-and-cancel-stale.ts');
  const sql24 = await read('../supabase/migrations/20261124000000_unified_10min_pix_stock_hold.sql');
  const claim24 = sql24.slice(
    sql24.indexOf('create or replace function public.claim_expired_pix_cancellations'),
    sql24.indexOf('create or replace function public.complete_expired_pix_cancellation'),
  );
  assert.match(claim24, /lower\(coalesce\(p\.payment_method, 'pix'\)\) = 'pix'/);
  assert.doesNotMatch(claim24, /credit_card/);
  assert.match(worker, /claim_expired_pix_cancellations/);
  assert.match(worker, /expire_stale_order_payments/);
  const beforeLoop = worker.slice(0, worker.indexOf('for (const row of claimed)'));
  assert.doesNotMatch(beforeLoop, /credit_card/);
  assert.doesNotMatch(worker, /\.eq\(\s*['"]payment_method['"]\s*,\s*['"]credit_card['"]\s*\)/);
});
