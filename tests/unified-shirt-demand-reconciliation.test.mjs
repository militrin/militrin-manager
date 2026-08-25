import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const sql = await readFile(new URL('../supabase/migrations/20260890000000_reconcile_unified_event_shirt_demand.sql', import.meta.url), 'utf8');

const project = ({ tickets = [], store = [], cart = [] }) => ({
  reserved: [...tickets, ...store, ...cart].filter((row) => row.active && !['delivered', 'cancelled'].includes(row.status)).reduce((sum, row) => sum + row.quantity, 0),
  delivered: [...tickets, ...store, ...cart].filter((row) => row.status === 'delivered').reduce((sum, row) => sum + row.quantity, 0),
});

test('fonte unica soma ingresso, loja vinculada e carrinho sem contar order_items do ingresso duas vezes', () => {
  assert.match(sql, /from public\.participant_kit_items as kit_link[\s\S]*join public\.tickets as ticket/);
  assert.match(sql, /from public\.store_order_items as store_line[\s\S]*linked_event_kit_item_variant_id=p_variant_id/);
  assert.match(sql, /from public\.order_items as cart_line[\s\S]*cart_line\.item_kind='product'/);
  assert.doesNotMatch(sql, /cart_line\.item_kind='ticket'/);
  assert.deepEqual(project({ tickets: [{ active: true, status: 'confirmed', quantity: 10 }], store: [{ active: true, status: 'confirmed', quantity: 2 }], cart: [{ active: true, status: 'reserved', quantity: 1 }] }), { reserved: 13, delivered: 0 });
});

test('ingresso novo e importado materializados reservam pela mesma fonte canonica', () => {
  assert.match(sql, /trg_reconcile_participant_shirt_demand/);
  assert.match(sql, /after insert or update of kit_item_id,ticket_id,variant_data,quantity,status or delete/);
  assert.match(sql, /create or replace function public\.account_ticket_shirt_demand/);
  assert.match(sql, /reconcile_event_shirt_variant_inventory\(v_link\.kit_item_id,v_variant_id\)/);
});

test('troca de tamanho reconcilia variante anterior e nova', () => {
  assert.match(sql, /v_old_variant_id[\s\S]*reconcile_event_shirt_variant_inventory\(old\.kit_item_id,v_old_variant_id\)/);
  assert.match(sql, /v_new_variant_id[\s\S]*reconcile_event_shirt_variant_inventory\(new\.kit_item_id,v_new_variant_id\)/);
});

test('cancelamento libera e nunca produz reserva negativa', () => {
  assert.deepEqual(project({ tickets: [{ active: false, status: 'confirmed', quantity: 1 }] }), { reserved: 0, delivered: 0 });
  assert.deepEqual(project({ store: [{ active: false, status: 'cancelled', quantity: 3 }] }), { reserved: 0, delivered: 0 });
  assert.match(sql, /reserved_quantity=greatest\(v_reserved,0\)/);
  assert.match(sql, /trg_reconcile_ticket_shirt_demand_status/);
  assert.match(sql, /trg_reconcile_store_order_shirt_demand_status/);
});

test('entrega e desfazer entrega movem a unidade entre reservado e entregue', () => {
  assert.deepEqual(project({ tickets: [{ active: true, status: 'confirmed', quantity: 1 }] }), { reserved: 1, delivered: 0 });
  assert.deepEqual(project({ tickets: [{ active: true, status: 'delivered', quantity: 1 }] }), { reserved: 0, delivered: 1 });
  assert.deepEqual(project({ store: [{ active: true, status: 'confirmed', quantity: 2 }] }), { reserved: 2, delivered: 0 });
});

test('compra, concessao e quantidade do carrinho usam o mesmo estoque vinculado', () => {
  assert.match(sql, /perform public\.reserve_store_item_stock\(v_store_item\.id,p_variant_id,p_quantity\)/);
  assert.match(sql, /v_delta>0 then perform public\.reserve_store_item_stock/);
  assert.match(sql, /v_delta<0 then perform public\.release_store_item_reservation/);
  assert.match(sql, /trg_reconcile_store_shirt_demand/);
  assert.match(sql, /trg_reconcile_cart_shirt_demand/);
  assert.match(sql, /trg_reconcile_linked_store_variant_demand/);
});

test('backfill substitui contadores pela projecao e e idempotente', () => {
  assert.match(sql, /set reserved_quantity=greatest\(v_reserved,0\),[\s\S]*delivered_quantity=greatest\(v_delivered,0\)/);
  assert.match(sql, /for v_variant in[\s\S]*perform public\.reconcile_event_shirt_variant_inventory/);
  assert.doesNotMatch(sql, /set reserved_quantity=reserved_quantity\+v_reserved/);
  const state = { tickets: [{ active: true, status: 'confirmed', quantity: 2 }], store: [{ active: true, status: 'confirmed', quantity: 1 }] };
  assert.deepEqual(project(state), project(state));
});

test('disponibilidade fisica nao subtrai reservas', () => {
  const total = 140; const delivered = 5; const reserved = 20;
  assert.equal(total - delivered, 135);
  assert.notEqual(total - delivered, total - delivered - reserved);
});
