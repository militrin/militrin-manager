import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(path) {
  return (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
}

test('20261124: uma funcao STABLE de demanda e UI/writer compartilham ela', async () => {
  const sql = await read('../supabase/migrations/20261124000000_unified_10min_pix_stock_hold.sql');
  assert.match(sql, /create or replace function public\.canonical_shirt_valid_unaccounted_hold_qty/);
  assert.match(sql, /language sql\nstable/);
  assert.match(sql, /create or replace function public\.checkout_hold_expires_at/);
  const ui = sql.slice(
    sql.indexOf('create or replace function public.get_event_shirt_stock_for_selection'),
    sql.indexOf('create or replace function public.expire_stale_order_payments'),
  );
  const writer = sql.slice(
    sql.indexOf('create or replace function public.canonical_shirt_available_for_new_reservation'),
    sql.indexOf('create or replace function public.get_event_shirt_stock_for_selection'),
  );
  assert.match(ui, /canonical_shirt_valid_unaccounted_hold_qty/);
  assert.match(ui, /checkout_hold_quantity/);
  assert.match(writer, /canonical_shirt_valid_unaccounted_hold_qty/);
  assert.match(writer, /for update/);
  assert.doesNotMatch(ui, /for update/i);
  assert.match(sql, /p_exclude_order_item_id/);
});

test('20261124: hold unificado de 10 minutos no checkout, PIX e cron', async () => {
  const sql = await read('../supabase/migrations/20261124000000_unified_10min_pix_stock_hold.sql');
  assert.match(sql, /v_reservation_expires_at := now\(\) \+ interval '10 minutes'/);
  assert.match(sql, /v_hold := now\(\) \+ interval '10 minutes'/);
  assert.match(sql, /expires_at = v_hold/);
  assert.doesNotMatch(sql, /interval '2 hours'/);
  assert.match(sql, /expire_stale_order_payments_every_1m/);
  assert.match(sql, /pending_cancel_provider_payment_id/);
  assert.match(sql, /claim_expired_pix_cancellations/);
  assert.match(sql, /complete_expired_pix_cancellation/);
  assert.match(sql, /fail_expired_pix_cancellation/);
  assert.match(sql, /is_short_checkout_hold/);
});

test('20261124: checkout_legacy nao decide por shirt_inventory.reserved/delivered', async () => {
  const sql = await read('../supabase/migrations/20261124000000_unified_10min_pix_stock_hold.sql');
  const legacy = sql.slice(sql.indexOf('create or replace function public.create_multi_ticket_order_checkout_legacy'));
  assert.doesNotMatch(legacy, /v_available_stock := coalesce\(v_inventory\.total_quantity/);
  assert.doesNotMatch(legacy, /reserved_quantity, 0\) - coalesce\(v_inventory\.delivered_quantity/);
});

test('20261124: estoque so libera apos DELETE confirmado; legado e cartao fora do worker', async () => {
  const sql = await read('../supabase/migrations/20261124000000_unified_10min_pix_stock_hold.sql');
  const expire = sql.slice(
    sql.indexOf('create or replace function public.expire_stale_order_payments'),
    sql.indexOf('create or replace function public.claim_expired_pix_cancellations'),
  );
  assert.match(expire, /pending_cancel_provider_payment_id/);
  assert.match(expire, /lower\(coalesce\(p\.payment_method, 'pix'\)\) = 'pix'/);
  assert.doesNotMatch(expire, /_apply_terminal_order_payment_status\(v_payment\.id, 'expired'\)[\s\S]*v_needs_gateway/);
  assert.match(sql, /2301\/2302/);
  assert.match(sql, /2295/);
  assert.doesNotMatch(sql, /update public\.order_items set status = 'expired'/);
  assert.doesNotMatch(sql, /Gian Antonio/);
});

test('PIX Asaas local e fake usam hold de 10 minutos; worker DELETE antes de terminalizar', async () => {
  const asaas = await read('../src/lib/payments/asaas-provider.ts');
  const fake = await read('../src/lib/payments/fake-gateway-provider.ts');
  const worker = await read('../src/lib/payments/expire-and-cancel-stale.ts');
  const route = await read('../src/app/api/internal/expire-payments/route.ts');
  const vercel = await read('../vercel.json');
  assert.match(asaas, /checkoutHoldExpiresAtIso\(\)/);
  assert.match(fake, /checkoutHoldExpiresAtIso\(\)/);
  assert.match(worker, /complete_expired_pix_cancellation/);
  assert.match(worker, /fail_expired_pix_cancellation/);
  assert.match(worker, /apply_gateway_payment_status/);
  assert.match(worker, /cancelPayment/);
  assert.match(route, /CRON_SECRET/);
  assert.match(vercel, /\/api\/internal\/expire-payments/);
  assert.match(vercel, /\* \* \* \* \*/);
});

test('UI omite/desabilita variante com available=0 de forma coerente', async () => {
  const wizard = await read('../src/app/inscricao/[eventSlug]/wizard.tsx');
  const emitir = await read('../src/app/ingressos/emitir/actions.ts');
  assert.match(wizard, /disabledOption = enforcePhysicalStock && effectiveStock <= 0/);
  assert.match(emitir, /available_quantity > 0/);
});

test('/camisetas separa disponivel para nova venda e reservado temporariamente', async () => {
  const page = await read('../src/app/camisetas/page.tsx');
  const table = await read('../src/components/mvp/ShirtStockTable.tsx');
  assert.match(page, /get_event_shirt_stock_for_selection/);
  assert.match(page, /available_for_sale/);
  assert.match(page, /checkout_hold_quantity/);
  assert.match(table, /Disponível para nova venda/);
  assert.match(table, /Reservado temporariamente/);
});
