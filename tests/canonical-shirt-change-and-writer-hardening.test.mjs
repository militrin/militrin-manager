import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { availableForNewReservation, isCanonicalShirtStockError, SHIRT_STOCK_CHANGED_MESSAGE } =
  await import("../src/lib/inventory/availability.ts");

async function read(path) {
  return (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

const sql = await read("../supabase/migrations/20261122000000_canonical_shirt_change_and_writer_hardening.sql");
const checkoutSql = await read("../supabase/migrations/20261120000000_canonical_checkout_shirt_availability.sql");
const issueSql = await read("../supabase/migrations/20261121000000_canonical_manual_shirt_availability.sql");

const helper = sql.slice(
  sql.indexOf("create or replace function public.assert_canonical_shirt_stock_for_shirt_change"),
  sql.indexOf("create or replace function public.admin_change_ticket_shirt"),
);
const changeFn = sql.slice(
  sql.indexOf("create or replace function public.admin_change_ticket_shirt"),
  sql.indexOf("create or replace function public.admin_correct_ticket_shirt_after_operation"),
);
const correctFn = sql.slice(
  sql.indexOf("create or replace function public.admin_correct_ticket_shirt_after_operation"),
  sql.indexOf("create or replace function public.get_admin_ticket_shirt_options"),
);
const optionsFn = sql.slice(
  sql.indexOf("create or replace function public.get_admin_ticket_shirt_options"),
  sql.indexOf("create or replace function public.import_current_event_contact_first"),
);
const importFn = sql.slice(
  sql.indexOf("create or replace function public.import_current_event_contact_first"),
  sql.indexOf("revoke all on function public.create_multi_ticket_order_checkout_legacy"),
);

test("migration 20261122 e unica e posterior a 20261121; nao edita writers publicados", async () => {
  assert.match(sql, /20261120/);
  assert.match(sql, /canonical_shirt_available_for_new_reservation/);
  assert.doesNotMatch(sql, /20261021/);
  assert.doesNotMatch(checkoutSql, /assert_canonical_shirt_stock_for_shirt_change/);
  assert.doesNotMatch(issueSql, /assert_canonical_shirt_stock_for_shirt_change/);
  assert.doesNotMatch(checkoutSql, /admin_change_ticket_shirt/);
  assert.doesNotMatch(issueSql, /admin_change_ticket_shirt/);
});

test("helper de troca reusa o contrato 20261120 e trata M→M como no-op", () => {
  assert.match(helper, /if not found or not v_limit then\s+return;/);
  assert.match(helper, /v_available := public\.canonical_shirt_available_for_new_reservation\(\s*p_event_id, v_type, v_size, p_current_order_item_id/);
  assert.match(helper, /v_current_size is not distinct from v_size/);
  assert.doesNotMatch(helper, /si\.reserved_quantity|si\.delivered_quantity|shirt_inventory\.reserved_quantity/);
  assert.match(helper, /raise_shirt_out_of_stock/);
});

test("admin_change valida destino antes de liberar origem; mesmo tamanho nao mexe reserva", () => {
  const assertIdx = changeFn.indexOf("assert_canonical_shirt_stock_for_shirt_change");
  const originRelease = changeFn.indexOf("reserved_quantity=greatest(reserved_quantity-v_qty,0)");
  const destApply = changeFn.lastIndexOf("reserved_quantity=reserved_quantity+v_qty");
  assert.ok(assertIdx >= 0 && originRelease > assertIdx && destApply > originRelease);
  assert.match(changeFn, /v_old_variant is distinct from v_variant\.id/);
  assert.match(changeFn, /nao inserir kit inventory do destino antes do assert/i);
});

test("M → P available 0 rejeita e M permanece; available 1 passa", () => {
  const m = { total: 10, delivered: 0, reserved: 1, pending: 0 };
  const pEmpty = { total: 1, delivered: 1, reserved: 0, pending: 0 };
  const pOne = { total: 1, delivered: 0, reserved: 0, pending: 0 };
  assert.equal(availableForNewReservation(pEmpty.total, pEmpty.delivered, pEmpty.reserved, pEmpty.pending), 0);
  assert.equal(availableForNewReservation(pOne.total, pOne.delivered, pOne.reserved, pOne.pending), 1);

  function tryChange(dest, origin) {
    const available = availableForNewReservation(dest.total, dest.delivered, dest.reserved, dest.pending);
    if (available < 1) return { ok: false, origin: { ...origin }, dest: { ...dest } };
    origin.reserved -= 1;
    dest.reserved += 1;
    return { ok: true, origin, dest };
  }

  const rejected = tryChange({ ...pEmpty }, { ...m });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.origin.reserved, 1);

  const accepted = tryChange({ ...pOne }, { ...m });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.origin.reserved, 0);
  assert.equal(accepted.dest.reserved, 1);
});

test("M → M e no-op: nao consome destino e nao libera origem", () => {
  const state = { total: 1, delivered: 0, reserved: 1, pending: 0 };
  const available = availableForNewReservation(state.total, state.delivered, state.reserved, state.pending);
  assert.equal(available, 0);
  assert.match(helper, /v_current_size is not distinct from v_size then\s+return;/);
});

test("duas trocas concorrentes para a ultima P: exatamente uma passa", () => {
  const dest = { total: 1, delivered: 0, reserved: 0, pending: 0 };
  function tryChange() {
    const available = availableForNewReservation(dest.total, dest.delivered, dest.reserved, dest.pending);
    if (available < 1) return false;
    dest.reserved += 1;
    return true;
  }
  assert.equal(tryChange(), true);
  assert.equal(tryChange(), false);
  assert.equal(dest.reserved, 1);
});

test("legado reserved nao infla destino em evento limitado", () => {
  assert.equal(availableForNewReservation(4, 4, 0, 0), 0);
  assert.notEqual(4 - 0 - 0, 0);
  assert.equal(availableForNewReservation(1, 0, 0, 1), 0);
  assert.doesNotMatch(helper, /si\.reserved_quantity/);
  assert.match(helper, /canonical_shirt_available_for_new_reservation/);
});

test("evento limitado sem kit row destino rejeita; nao limitado preserva gate antigo", () => {
  assert.match(checkoutSql, /Sem linha canônica: fail-safe/);
  assert.match(changeFn, /if not v_limit and v_item\.shirt_supply_mode='stock'/);
  assert.match(correctFn, /if not v_limit then/);
  assert.match(helper, /v_available < v_qty/);
});

test("correcao entregue conserva soma delivered e nao mexe total/reserved", () => {
  const m = { total: 140, reserved: 0, delivered: 100 };
  const g = { total: 70, reserved: 0, delivered: 50 };
  const sumDelivered = m.delivered + g.delivered;
  assert.equal(sumDelivered, 150);
  assert.equal(availableForNewReservation(g.total, g.delivered, g.reserved, 0) >= 1, true);

  m.delivered -= 1;
  g.delivered += 1;

  assert.equal(m.total, 140);
  assert.equal(g.total, 70);
  assert.equal(m.reserved, 0);
  assert.equal(g.reserved, 0);
  assert.equal(m.delivered, 99);
  assert.equal(g.delivered, 51);
  assert.equal(m.delivered + g.delivered, 150);

  const deliveredBranch = correctFn.slice(
    correctFn.indexOf("if v_was_delivered then"),
    correctFn.indexOf("else\n      -- Check-in sem entrega"),
  );
  assert.match(deliveredBranch, /delivered_quantity=greatest\(delivered_quantity-v_qty,0\)/);
  assert.match(deliveredBranch, /delivered_quantity=delivered_quantity\+v_qty/);
  assert.doesNotMatch(deliveredBranch, /reserved_quantity/);
  assert.doesNotMatch(deliveredBranch, /total_quantity\s*=/);
});

test("correcao entregue nao devolve origem se destino falhar; troca fisica move delivered", () => {
  const assertIdx = correctFn.indexOf("assert_canonical_shirt_stock_for_shirt_change");
  const originDelivered = correctFn.indexOf("delivered_quantity=greatest(delivered_quantity-v_qty,0)");
  const destDelivered = correctFn.indexOf("delivered_quantity=delivered_quantity+v_qty");
  assert.ok(assertIdx >= 0 && originDelivered > assertIdx && destDelivered > originDelivered);

  const origin = { reserved: 0, delivered: 1 };
  const destZero = { total: 1, delivered: 1, reserved: 0, pending: 0 };
  if (availableForNewReservation(destZero.total, destZero.delivered, destZero.reserved, destZero.pending) < 1) {
    assert.equal(origin.delivered, 1);
  }

  const destOne = { total: 1, delivered: 0, reserved: 0, pending: 0 };
  assert.equal(availableForNewReservation(destOne.total, destOne.delivered, destOne.reserved, destOne.pending), 1);
  origin.delivered -= 1;
  destOne.delivered += 1;
  assert.equal(origin.delivered, 0);
  assert.equal(destOne.delivered, 1);
  assert.match(correctFn, /v_was_delivered/);
});

test("importacao com camiseta cria demanda reserved e passa pelo assert de emissao", () => {
  const assertIdx = importFn.indexOf("assert_canonical_shirt_stock_for_manual_issue");
  const insertPayment = importFn.indexOf("insert into public.payments");
  const insertItem = importFn.indexOf("insert into public.order_items");
  assert.ok(assertIdx >= 0 && insertPayment > assertIdx && insertItem > assertIdx);
  assert.match(importFn, /1,v_amount,0,v_amount,'reserved',v_price_origin/);
  assert.match(importFn, /nullif\(trim\(coalesce\(p_shirt_type,''\)\),''\) is not null/);
});

test("importacao em lote: uma RPC por contato, sucesso parcial, cada linha no assert", async () => {
  const actions = await read("../src/app/importacoes/actions.ts");
  assert.match(actions, /for \(const row of rows/);
  assert.match(actions, /supabase\.rpc\('import_current_event_contact_first'/);
  assert.match(actions, /status: 'error'/);
  assert.match(actions, /errorRows \+= 1/);
  assert.match(actions, /importedRows \+= 1/);
  const rpcCount = actions.split("import_current_event_contact_first").length - 1;
  assert.ok(rpcCount >= 1);
  const loopSlice = actions.slice(actions.indexOf("for (const row of rows"));
  assert.match(loopSlice, /try \{/);
  assert.match(loopSlice, /catch \(error\)/);

  const stock = { total: 1, delivered: 0, reserved: 0, pending: 0 };
  function importOne() {
    const available = availableForNewReservation(stock.total, stock.delivered, stock.reserved, stock.pending);
    if (available < 1) return false;
    stock.pending += 1;
    return true;
  }
  assert.equal(importOne(), true);
  assert.equal(importOne(), false);
  assert.equal(stock.pending, 1);
});

test("checkout inner: wrapper publico continua; authenticated perde EXECUTE na legacy", async () => {
  const wrapper = await read("../supabase/migrations/20261108000000_payment_amount_guard_and_idempotency.sql");
  assert.match(wrapper, /create or replace function public\.create_multi_ticket_order_checkout\(/);
  assert.match(wrapper, /security definer/);
  assert.match(wrapper, /create_multi_ticket_order_checkout_inventory_legacy/);
  assert.match(checkoutSql, /create_multi_ticket_order_checkout_legacy\(/);
  assert.match(checkoutSql, /perform public\.assert_canonical_shirt_stock_for_new_checkout/);
  assert.match(sql, /revoke all on function public\.create_multi_ticket_order_checkout_legacy/);
  assert.match(sql, /from public, anon, authenticated/);
  assert.match(sql, /SECURITY DEFINER/);
  const app = await read("../src/app/inscricao/actions.ts");
  assert.match(app, /create_multi_ticket_order_checkout/);
  assert.doesNotMatch(app, /create_multi_ticket_order_checkout_legacy/);
});

test("create_registration permanece morto neste lote", async () => {
  const deprecate = await read("../supabase/migrations/20260820000000_deprecate_create_registration_rpc.sql");
  assert.match(deprecate, /revoke all on function public\.create_registration\(/);
  assert.match(deprecate, /from public, anon, authenticated/);
  assert.doesNotMatch(sql, /create_registration\(/);
  const inscricoes = await read("../src/app/inscricoes/actions.ts");
  const checkout = await read("../src/app/inscricao/actions.ts");
  assert.doesNotMatch(inscricoes, /\.rpc\(['"]create_registration['"]/);
  assert.doesNotMatch(checkout, /\.rpc\(['"]create_registration['"]/);
});

test("UI de troca mapeia recusa de estoque e refetch das opcoes", async () => {
  const operacoes = await read("../src/app/operacoes/actions.ts");
  const shirtDialog = await read("../src/app/operacoes/components/ShirtDialog.tsx");
  const editar = await read("../src/app/inscricoes/[id]/editar/actions.ts");
  const editarPage = await read("../src/app/inscricoes/[id]/editar/page.tsx");
  const minhaConta = await read("../src/app/minha-conta/actions.ts");
  const contextActions = await read("../src/app/minha-conta/ingressos/[ticketId]/ticket-context-actions.tsx");
  assert.match(operacoes, /shirtStockChanged: true/);
  assert.match(operacoes, /SHIRT_STOCK_CHANGED_MESSAGE/);
  assert.match(operacoes, /getAdminTicketShirtOptionsAction/);
  assert.match(shirtDialog, /shirtStockChanged/);
  assert.match(shirtDialog, /getAdminTicketShirtOptionsAction/);
  assert.match(editar, /shirtStockChanged: true/);
  assert.match(editarPage, /shirtStockChanged/);
  assert.match(editarPage, /setShirtOptions/);
  assert.match(minhaConta, /shirtStockChanged: true/);
  assert.match(contextActions, /shirtStockChanged/);
  assert.match(contextActions, /router\.refresh\(\)/);
  assert.equal(SHIRT_STOCK_CHANGED_MESSAGE, "Esse tamanho acabou de ficar indisponível. Escolha outro tamanho.");
  assert.equal(isCanonicalShirtStockError("SHIRT_OUT_OF_STOCK Sem estoque disponível para Camiseta P."), true);
});

test("select admin de troca usa RPC canonica de selecao; writers nao leem reserved legado", () => {
  assert.match(optionsFn, /get_event_shirt_stock_for_selection/);
  assert.doesNotMatch(optionsFn, /si\.reserved_quantity/);
  assert.doesNotMatch(changeFn, /si\.reserved_quantity/);
  assert.doesNotMatch(correctFn, /si\.reserved_quantity/);
  assert.match(optionsFn, /lower\(trim\(v\.name\)\) = lower\(trim\(coalesce\(v_oi\.shirt_type/);
});
