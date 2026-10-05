import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { availableForNewReservation } = await import("../src/lib/inventory/availability.ts");

async function read(path) {
  return (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

const sql = await read("../supabase/migrations/20261121000000_canonical_manual_shirt_availability.sql");
const checkoutSql = await read("../supabase/migrations/20261120000000_canonical_checkout_shirt_availability.sql");
const registration = sql.slice(
  sql.indexOf("create or replace function public.create_manual_registration_order"),
  sql.indexOf("create or replace function public.create_manual_unassigned_ticket_order"),
);
const unassigned = sql.slice(
  sql.indexOf("create or replace function public.create_manual_unassigned_ticket_order"),
  sql.indexOf("create or replace function public.issue_manual_ticket_batch("),
);
const batch = sql.slice(sql.indexOf("create or replace function public.issue_manual_ticket_batch("));
const helper = sql.slice(
  sql.indexOf("create or replace function public.assert_canonical_shirt_stock_for_manual_issue"),
  sql.indexOf("create or replace function public.create_manual_registration_order"),
);

test("migration 20261121 e unica e posterior a 20261120; nao edita writers antigos", async () => {
  assert.match(sql, /20261120/);
  assert.match(sql, /canonical_shirt_available_for_new_reservation/);
  assert.doesNotMatch(sql, /20261021/);
  const oldRegistration = await read("../supabase/migrations/20261021000000_manual_registration_administrative_buyer_type.sql");
  const oldUnassigned = await read("../supabase/migrations/20260871000000_manual_issue_categoryless_ticket.sql");
  const oldCheckout = checkoutSql;
  assert.doesNotMatch(oldRegistration, /assert_canonical_shirt_stock_for_manual_issue/);
  assert.match(oldUnassigned, /total_quantity-v_inventory\.reserved_quantity-v_inventory\.delivered_quantity/);
  assert.match(oldCheckout, /create or replace function public\.canonical_shirt_available_for_new_reservation/);
});

test("helper reusa o contrato 20261120 e ignora reserved legado", () => {
  assert.match(helper, /if not found or not v_limit then\s+return;/);
  assert.match(helper, /v_available := public\.canonical_shirt_available_for_new_reservation/);
  assert.doesNotMatch(helper, /si\.reserved_quantity|si\.delivered_quantity|shirt_inventory\.reserved_quantity/);
  assert.match(helper, /Sem estoque disponível para % %\./);
  assert.match(helper, /Há apenas 1 unidade disponível/);
});

test("registration valida estoque canônico ANTES de criar pedido", () => {
  const assertIdx = registration.indexOf("assert_canonical_shirt_stock_for_manual_issue");
  const insertIdx = registration.indexOf("insert into public.orders");
  assert.ok(assertIdx >= 0 && insertIdx > assertIdx);
  assert.match(registration, /assert_canonical_shirt_stock_for_manual_issue\(p_event_id, v_type, v_size, 1\)/);
});

test("unassigned deixa de autorizar com reserved/delivered legado", () => {
  assert.doesNotMatch(
    unassigned,
    /total_quantity-v_inventory\.reserved_quantity-v_inventory\.delivered_quantity/,
  );
  assert.doesNotMatch(unassigned, /update public\.shirt_inventory set reserved_quantity=reserved_quantity\+1/);
  const assertIdx = unassigned.indexOf("assert_canonical_shirt_stock_for_manual_issue");
  const insertIdx = unassigned.indexOf("insert into public.orders");
  assert.ok(assertIdx >= 0 && insertIdx > assertIdx);
});

test("batch valida quantidade total antes de materializar e permanece uma transacao", () => {
  const assertIdx = batch.indexOf("assert_canonical_shirt_stock_for_manual_issue");
  const firstCreate = batch.indexOf("create_manual_registration_order");
  const extraCreate = batch.indexOf("create_manual_unassigned_ticket_order");
  assert.ok(assertIdx >= 0 && firstCreate > assertIdx && extraCreate > assertIdx);
  assert.match(batch, /assert_canonical_shirt_stock_for_manual_issue\(\s*p_event_id, p_shirt_type, p_shirt_size, p_quantity/);
  const batchFn = batch.slice(0, batch.indexOf("\nend;\n$$;") + 9);
  assert.match(batchFn, /language plpgsql/);
  assert.doesNotMatch(batchFn, /\bcommit\b/i);
});

test("evento limitado: formula canônica rejeita 0 e aceita 1", () => {
  assert.equal(availableForNewReservation(4, 4, 0), 0);
  assert.equal(availableForNewReservation(3, 1, 2), 0);
  assert.equal(availableForNewReservation(11, 9, 1), 1);
  assert.equal(availableForNewReservation(11, 9, 1, 0) >= 1, true);
  assert.equal(availableForNewReservation(11, 9, 1, 1), 0);
  assert.notEqual(availableForNewReservation(4, 0, 0), 0);
  assert.equal(availableForNewReservation(4, 0, 99), 0);
});

test("lote: available 2 e qty 3 rejeita sem emitir; available 3 e qty 3 cabe", () => {
  assert.equal(availableForNewReservation(10, 5, 3) >= 3, false);
  assert.equal(availableForNewReservation(10, 5, 3), 2);
  assert.equal(availableForNewReservation(10, 5, 2) >= 3, true);
  assert.equal(availableForNewReservation(10, 5, 2), 3);
});

test("concorrencia: available 1, segunda reserva pendente perde", () => {
  const state = { total: 1, delivered: 0, reserved: 0, pending: 0 };
  function tryIssue(qty) {
    const available = availableForNewReservation(state.total, state.delivered, state.reserved, state.pending);
    if (available < qty) return false;
    state.pending += qty;
    return true;
  }
  assert.equal(tryIssue(1), true);
  assert.equal(tryIssue(1), false);
});

test("UI de emitir mapeia recusa de estoque e refetch das opcoes", async () => {
  const actions = await read("../src/app/ingressos/emitir/actions.ts");
  const form = await read("../src/app/ingressos/emitir/issue-ticket-form.tsx");
  assert.match(actions, /mapManualIssueShirtStockMessage/);
  assert.match(actions, /shirtStockChanged: true/);
  assert.match(actions, /Esse tamanho acabou de ficar indisponível/);
  assert.match(form, /shirtStockChanged/);
  assert.match(form, /getEventShirtOptionsAction\(eventId\)/);
  assert.match(form, /if \(!nextSizes\.includes\(shirtSize\)\) setShirtSize\(""\)/);
});

test("select admin continua na RPC canônica; writers passam pelo mesmo helper", async () => {
  const actions = await read("../src/app/ingressos/emitir/actions.ts");
  assert.match(actions, /get_event_shirt_stock_for_selection/);
  assert.match(actions, /issue_manual_ticket_batch/);
  assert.doesNotMatch(actions, /create_manual_registration_order/);
  assert.doesNotMatch(helper, /si\.reserved_quantity/);
});
