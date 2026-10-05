import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { availableForNewReservation, shirtAvailabilityText } = await import('../src/lib/inventory/availability.ts');

async function read(path) {
  return (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
}

test('checkout UI deixa de ler reserved/delivered legado de shirt_inventory', async () => {
  const page = await read('../src/app/inscricao/[eventSlug]/page.tsx');
  assert.match(page, /get_event_shirt_stock_for_selection/);
  assert.doesNotMatch(page, /\.from\('shirt_inventory'\)/);
  assert.match(page, /available_quantity: Number\(row\.available_quantity \?\? 0\)/);
});

test('SQL canonico: total shirt_inventory, demanda kit, max(total-delivered-reserved,0), ignora reserved legado na formula', async () => {
  const sql = await read('../supabase/migrations/20261120000000_canonical_checkout_shirt_availability.sql');
  assert.match(sql, /create or replace function public\.get_event_shirt_stock_for_selection/);
  assert.match(sql, /create or replace function public\.canonical_shirt_available_for_new_reservation/);
  assert.match(sql, /greatest\(v_total - v_delivered - v_reserved - coalesce\(v_pending, 0\), 0\)/);
  assert.match(sql, /from public\.event_kit_item_variant_inventory inv/);
  assert.match(sql, /perform public\.assert_canonical_shirt_stock_for_new_checkout/);
  assert.match(sql, /if v_limit_stock then/);
  const availableFn = sql.slice(
    sql.indexOf('create or replace function public.canonical_shirt_available_for_new_reservation'),
    sql.indexOf('create or replace function public.assert_canonical_shirt_stock_for_new_checkout'),
  );
  assert.doesNotMatch(availableFn, /si\.reserved_quantity/);
  assert.match(availableFn, /p_exclude_order_item_id/);
  const rpcFn = sql.slice(
    sql.indexOf('create or replace function public.get_event_shirt_stock_for_selection'),
    sql.indexOf('create or replace function public.create_multi_ticket_order_checkout_inventory_legacy'),
  );
  assert.doesNotMatch(rpcFn, /si\.reserved_quantity/);
  assert.doesNotMatch(rpcFn, /si\.delivered_quantity/);
  assert.match(rpcFn, /kit\.has_canonical/);
  assert.match(rpcFn, /when coalesce\(e\.limit_shirt_selection_to_stock, false\) then 0/);
  assert.match(availableFn, /Sem linha canônica: fail-safe/);
  assert.match(sql, /canonical_shirt_available_for_new_reservation\(\s*v_order\.event_id, v_new_type, v_new_size, p_order_item_id/);
});

test('PP/EXGG/EXG: legado sujo nao pode inflar available', () => {
  assert.equal(availableForNewReservation(4, 4, 0), 0);
  assert.notEqual(4 - 0 - 0, 0);
  assert.equal(availableForNewReservation(3, 1, 2), 0);
  assert.notEqual(3 - 0 - 2, 0);
  assert.equal(availableForNewReservation(11, 9, 1), 1);
  assert.notEqual(11 - 0 - 6, 1);
  assert.equal(shirtAvailabilityText(0, true), 'Esgotado');
  assert.equal(shirtAvailabilityText(1, true), 'Resta apenas 1 unidade');
});

test('helper TS: available da RPC prevalece; limitado sem linha canônica nao volta ao total', async () => {
  const { buildShirtInventoryVariants } = await import('../src/lib/constants/shirts.ts');
  const [limitedMissingKit] = buildShirtInventoryVariants([{
    shirt_type: 'Camiseta',
    shirt_size: 'PP',
    total_quantity: 4,
    reserved_quantity: 0,
    delivered_quantity: 0,
    available_quantity: 0,
  }]);
  assert.equal(limitedMissingKit.available_quantity, 0);
  const [adminOverlay] = buildShirtInventoryVariants([{
    shirt_type: 'Camiseta',
    shirt_size: 'PP',
    total_quantity: 4,
    reserved_quantity: 0,
    delivered_quantity: 4,
  }]);
  assert.equal(adminOverlay.available_quantity, 0);
});
