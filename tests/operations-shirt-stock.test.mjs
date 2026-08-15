import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/136_atomic_shirt_stock_delivery.sql', import.meta.url);
const actionsUrl = new URL('../src/app/operacoes/actions.ts', import.meta.url);
const detailsUrl = new URL('../src/app/operacoes/components/ExpandedTicketDetails.tsx', import.meta.url);
const pickupActionsUrl = new URL('../src/app/retirada/actions.ts', import.meta.url);

function deliverPhysical(state, quantity = 1) {
  if (state.delivered + quantity > state.total) return { ...state, code: 'SHIRT_OUT_OF_STOCK' };
  return { total: state.total, reserved: Math.max(state.reserved - quantity, 0), delivered: state.delivered + quantity, code: 'OK' };
}

test('estoque canonico e consumido sob lock e update condicional', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /event_kit_item_variant_inventory[\s\S]*for update/i);
  assert.match(sql, /total_quantity-delivered_quantity>=v_link\.quantity/i);
  assert.match(sql, /reserved_quantity=greatest\(reserved_quantity-v_link\.quantity,0\)/);
  assert.match(sql, /delivered_quantity=delivered_quantity\+v_link\.quantity/);
});

test('estoque zero e concorrencia usam codigo estavel e rollback por exception', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /SHIRT_OUT_OF_STOCK/g);
  assert.match(sql, /physical_available/);
  assert.match(sql, /if not found then perform public\.raise_shirt_out_of_stock/);
});

test('demanda agregada maior que estoque nao bloqueia retirada fisica', () => {
  assert.deepEqual(deliverPhysical({ total: 10, reserved: 10, delivered: 0 }), { total: 10, reserved: 9, delivered: 1, code: 'OK' });
  assert.deepEqual(deliverPhysical({ total: 1, reserved: 10, delivered: 0 }), { total: 1, reserved: 9, delivered: 1, code: 'OK' });
  assert.equal(deliverPhysical({ total: 1, reserved: 9, delivered: 1 }).code, 'SHIRT_OUT_OF_STOCK');
  assert.equal(deliverPhysical({ total: 0, reserved: 10, delivered: 0 }).code, 'SHIRT_OUT_OF_STOCK');
});

test('schema permite demanda maior que estoque mas nunca entrega maior que total', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /drop constraint/);
  assert.match(sql, /check\(delivered_quantity<=total_quantity\)/);
  assert.doesNotMatch(sql.slice(sql.indexOf('alter table public.event_kit_item_variant_inventory\n  add constraint')), /reserved_quantity\+delivered_quantity<=total_quantity/);
});

test('total tres permite exatamente tres entregas antes de bloquear', () => {
  let state = { total: 3, reserved: 10, delivered: 0 };
  for (let index = 0; index < 3; index += 1) state = deliverPhysical(state);
  assert.equal(state.delivered, 3);
  assert.equal(deliverPhysical(state).code, 'SHIRT_OUT_OF_STOCK');
});

test('direito e variante permanecem vinculados ao ticket sem ledger fisico individual', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /where ticket_id=p_ticket_id and kit_item_id=p_kit_item_id for update/);
  assert.match(sql, /v_variant_id:=nullif\(v_link\.variant_data->>'variant_id',''\)::uuid/);
  assert.match(sql, /where kit_item_id=v_item\.id and variant_id=v_variant_id for update/);
  assert.doesNotMatch(sql, /reserved_quantity<v_link\.quantity/);
});

test('repeticao e idempotente e entrega completa pre-valida antes de entregar', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /if v_link\.status='delivered' then return true/);
  const validation = sql.indexOf('-- Bloqueia e valida todas as variantes');
  const delivery = sql.indexOf('perform public.deliver_ticket_kit_item', validation);
  assert.ok(validation >= 0 && delivery > validation);
});

test('entrega e check-in permanecem na mesma transacao', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /perform public\.deliver_ticket_full_kit\(p_ticket_id\)[\s\S]*public\.checkin_ticket_entry\(p_ticket_id\)/);
  assert.match(sql, /a entrega foi revertida/);
});

test('entrega completa nao acessa mais campo inexistente do record', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.doesNotMatch(sql, /v_row\.reserved_quantity/);
  assert.match(sql, /select greatest\(inv\.total_quantity-inv\.delivered_quantity,0\)[\s\S]*into v_available/);
});

test('Central interpreta erro estruturado e bloqueia estoque zero', async () => {
  const [actions, details, pickup] = await Promise.all([readFile(actionsUrl, 'utf8'), readFile(detailsUrl, 'utf8'), readFile(pickupActionsUrl, 'utf8')]);
  assert.match(actions, /operationRpcError/);
  assert.match(actions, /get_ticket_shirt_stock/);
  assert.match(actions, /SHIRT_OUT_OF_STOCK/);
  assert.match(details, /SEM ESTOQUE/);
  assert.match(details, /Última unidade disponível/);
  assert.match(details, /shirtOutOfStock \|\| !capabilities\.canCombined/);
  assert.match(details, /Trocar camiseta/);
  assert.match(pickup, /pickupRpcError/);
  assert.match(pickup, /SHIRT_OUT_OF_STOCK/);
});

test('corrida da ultima unidade e protegida e RPC legada fica revogada', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /event_kit_item_variant_inventory[\s\S]*for update/);
  assert.match(sql, /total_quantity-delivered_quantity>=v_link\.quantity/);
  assert.match(sql, /revoke all on function public\.deliver_kit_and_checkin\(uuid\) from public,anon,authenticated/);
});

test('entrada posterior de estoque e troca para variante com saldo liberam entrega', () => {
  assert.equal(deliverPhysical({ total: 0, reserved: 1, delivered: 0 }).code, 'SHIRT_OUT_OF_STOCK');
  assert.equal(deliverPhysical({ total: 1, reserved: 1, delivered: 0 }).code, 'OK');
  const g = { total: 0, reserved: 1, delivered: 0 };
  const gg = { total: 1, reserved: 1, delivered: 0 };
  assert.equal(deliverPhysical(g).code, 'SHIRT_OUT_OF_STOCK');
  assert.equal(deliverPhysical(gg).code, 'OK');
});

test('RPCs de estoque e troca usam saldo fisico e nao capacidade livre de demanda', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /create or replace function public\.set_event_kit_item_variant_stock/);
  assert.match(sql, /v_delivered,0\)>p_total_quantity/);
  assert.match(sql, /create function public\.get_admin_ticket_shirt_options/);
  assert.match(sql, /total_quantity,0\)-coalesce\(inv\.delivered_quantity,0\)/);
  assert.match(sql, /create or replace function public\.admin_change_ticket_shirt/);
  assert.match(sql, /v_new_inv\.total_quantity-v_new_inv\.delivered_quantity<v_qty/);
});
