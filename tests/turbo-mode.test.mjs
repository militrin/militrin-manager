import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";

// Normaliza CRLF->LF (ver mesmo comentario em turbo-qr-camera-fallback.test.mjs).
async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

const migration = await readFile(
  new URL("../supabase/migrations/20260860000000_turbo_mode_wristband_and_store_item_qr.sql", import.meta.url),
  "utf8",
);
const actions = await readFile(new URL("../src/app/operacoes/actions.ts", import.meta.url), "utf8");
const types = await readFile(new URL("../src/app/operacoes/types.ts", import.meta.url), "utf8");
const turbo = await readFile(new URL("../src/app/operacoes/components/TurboMode.tsx", import.meta.url), "utf8");
const page = await readFile(new URL("../src/app/operacoes/page.tsx", import.meta.url), "utf8");
const storeOrderDetailActions = await readFile(new URL("../src/app/loja/pedidos/[orderId]/order-detail-actions.tsx", import.meta.url), "utf8");
const filters = await readFile(new URL("../src/app/operacoes/components/OperationsFilters.tsx", import.meta.url), "utf8");
const itemQrRoute = await readFile(
  new URL("../src/app/api/loja/pedidos/[storeOrderId]/itens/[itemId]/qrcode/route.ts", import.meta.url),
  "utf8",
);

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  return source.slice(start, end === -1 ? undefined : end);
}

// ============================================================
// Estados explicitos (nunca booleans concorrentes)
// ============================================================

test("Turbo estrutura a maquina de estados pedida (scanning_initial/ticket_review/scanning_wristband/ticket_success/product_review/product_success/error)", () => {
  for (const state of [
    "scanning_initial",
    "ticket_review",
    "scanning_wristband",
    "ticket_success",
    "product_review",
    "product_success",
    "error",
  ]) {
    assert.match(turbo, new RegExp(`kind: '${state}'`));
  }
  assert.match(turbo, /useReducer\(reducer/);
  assert.doesNotMatch(turbo, /useState<boolean>\(false\)\s*;\s*const \[\w+, set\w+\] = useState<boolean>\(false\)/);
});

test("botao Sair renderiza fora do switch de telas -- funciona em qualquer estado", () => {
  const chrome = slice(turbo, "function Chrome(", "function BigButton(");
  assert.match(chrome, /Sair do Modo Turbo/);
  const body = slice(turbo, "export function TurboMode(", "function TicketReview(");
  const chromeCallIndex = body.indexOf("<Chrome");
  const firstScreenIndex = body.indexOf("screen.kind ===");
  assert.ok(chromeCallIndex !== -1 && chromeCallIndex < firstScreenIndex, "Chrome (com o botao Sair) precisa envolver todas as telas, nao ficar dentro de um case especifico");
});

// ============================================================
// Leitor unico -- resolucao no backend, nunca confia no tipo vindo do
// frontend
// ============================================================

test("resolveTurboScanAction resolve ticket OU produto (qualquer canal) no backend, sem receber um 'tipo' do cliente", () => {
  const fn = slice(actions, "export async function resolveTurboScanAction", "export async function deliverKitCheckinAndLinkWristbandAction");
  assert.match(fn, /rawValue: string/);
  assert.doesNotMatch(fn, /kind\s*[:=]\s*['"](ticket|product)['"].*payload|payload\.kind/);
  assert.match(fn, /await assertPermission\("participants\.view"\)/);
  assert.match(fn, /\.from\("tickets"\)/);
  assert.match(fn, /resolveOperationalProductByQr/);
  assert.match(fn, /await assertPermission\("store\.deliver"\)/);
});

test("resolucao de item de loja (dentro da resolucao unificada) usa store_order_items.qr_token (nunca order_number, nunca id adulteravel sem lookup)", () => {
  const helper = slice(actions, "async function resolveStoreOrderItemByQr", "// Produto \"compre junto\"");
  assert.match(helper, /\.from\("store_order_items"\)/);
  assert.match(helper, /\.eq\("qr_token", tokenCandidate\)/);
});

test("entrega de ingresso e de produto (qualquer canal) reaproveitam as actions/RPCs canonicas ja existentes, via o dispatcher unico deliverOperationalProductItemAction -- nenhuma RPC de entrega duplicada", () => {
  assert.match(turbo, /deliverKitAndCheckinAction\(/);
  assert.match(turbo, /deliverOperationalProductItemAction\(/);
  assert.doesNotMatch(turbo, /rpc\(["']deliver_store_order_item["']|rpc\(["']deliver_order_item_product["']/);
  const dispatcher = slice(actions, "export async function deliverOperationalProductItemAction", "export async function deliverKitCheckinAndLinkWristbandAction");
  assert.match(dispatcher, /deliverAdditionalStoreItemAction\(item\.item_id\)/);
  assert.match(dispatcher, /deliverOrderItemProductAction\(item\.item_id\)/);
});

// ============================================================
// Fluxo A -- ingresso
// ============================================================

test("Proximo bloqueia ingresso cancelado, ja concluido, com pendencia de check-in/kit ou camiseta sem estoque fisico", () => {
  const fn = slice(turbo, "function getTicketBlockers", "function Chrome(");
  assert.match(fn, /ticket_status === 'cancelled'/);
  assert.match(fn, /checkin_status === 'done'/);
  assert.match(fn, /shirt_stock\?\.status === 'out_of_stock'/);
  assert.match(fn, /issue\.blocks_checkin \|\| issue\.blocks_kit_delivery/);
  const review = slice(turbo, "function TicketReview(", "function ProductReview(");
  assert.match(review, /canProceed = blockers\.length === 0/);
  assert.match(review, /disabled={!canProceed}/);
});

test("reserved_quantity isolado nunca bloqueia -- Turbo nao duplica a formula de estoque, so delega pras RPCs existentes", () => {
  assert.doesNotMatch(migration, /reserved_quantity/);
  const rpc = slice(migration, "create or replace function public.deliver_items_checkin_and_link_wristband");
  assert.match(rpc, /perform public\.deliver_ticket_full_kit\(p_ticket_id, p_wristband_code\)/);
});

test("Proximo pula a etapa de pulseira quando o evento nao usa pulseiras, ou quando o ingresso ja tem uma ativa", () => {
  const fn = slice(turbo, "async function handleNext", "async function handleWristbandScan");
  assert.match(fn, /event\.wristband_enabled && participant\.wristband\?\.status !== 'active'/);
  assert.match(fn, /GO_TO_WRISTBAND/);
  assert.match(fn, /deliverKitAndCheckinAction\(\{ ticket_id: participant\.ticket_id \}\)/);
});

test("pulseira vincula + entrega + checkin numa unica RPC atomica (sem bloco de excecao interno, mesmo padrao de deliver_items_and_checkin)", () => {
  const rpc = slice(migration, "create or replace function public.deliver_items_checkin_and_link_wristband", "revoke all on function public.deliver_items_checkin_and_link_wristband");
  assert.doesNotMatch(rpc, /exception\s+when/i);
  assert.match(rpc, /v_link_result := public\.link_wristband_to_ticket\(v_ticket\.id, v_code\)/);
  assert.match(rpc, /perform public\.deliver_ticket_full_kit\(p_ticket_id, p_wristband_code\)/);
  assert.match(rpc, /public\.checkin_ticket_entry\(p_ticket_id, p_wristband_code\)/);
});

test("pulseira e vinculada mesmo quando o evento nao a torna OBRIGATORIA (gap que as RPCs originais nao cobriam)", () => {
  const rpc = slice(migration, "create or replace function public.deliver_items_checkin_and_link_wristband", "revoke all on function public.deliver_items_checkin_and_link_wristband");
  assert.match(rpc, /if coalesce\(v_event\.wristband_enabled, false\) and v_code is not null then/);
  assert.doesNotMatch(rpc, /wristband_required_for/);
});

test("RPC nova exige kits.deliver, checkin.scan e (quando vincula pulseira) wristbands.link -- nenhum poder extra por entrar no Turbo", () => {
  const rpc = slice(migration, "create or replace function public.deliver_items_checkin_and_link_wristband", "revoke all on function public.deliver_items_checkin_and_link_wristband");
  assert.match(rpc, /current_user_has_permission\('kits\.deliver'\)/);
  assert.match(rpc, /current_user_has_permission\('checkin\.scan'\)/);
  assert.match(rpc, /current_user_has_permission\('wristbands\.link'\)/);
  const wrapper = slice(actions, "export async function deliverKitCheckinAndLinkWristbandAction");
  assert.match(wrapper, /await assertPermission\("kits\.deliver"\)/);
  assert.match(wrapper, /await assertPermission\("checkin\.scan"\)/);
});

test("sucesso do ingresso mostra 'Pulseira vinculada e check-in realizado' e complementa com 'Kit entregue com sucesso' so quando o evento tem kit", () => {
  const fn = slice(turbo, "async function handleWristbandScan", "async function handleProductConfirm");
  assert.match(fn, /Pulseira vinculada e check-in realizado/);
  assert.match(fn, /event\.has_kit \? 'Kit entregue com sucesso\.' : null/);
});

// ============================================================
// Fluxo B -- produto da loja
// ============================================================

test("QR de produto (qualquer canal, unificado nesta sessao) abre product_review com produto/variante/quantidade/pedido/comprador/evento -- nunca a ficha do ingresso inteiro", () => {
  const productReview = slice(turbo, "function ProductReview(", "function ProductAlreadyDelivered(");
  assert.match(productReview, /item\.product_name/);
  assert.match(productReview, /item\.variant/);
  assert.match(productReview, /item\.quantity\}x/);
  assert.match(productReview, /Confirmar entrega/);
  assert.doesNotMatch(productReview, /order_tickets|additional_items/);
});

test("produto cancelado ou com pagamento pendente bloqueia ANTES de abrir product_review; produto ja entregue abre o RESUMO da entrega (nunca um erro que so reseta o leitor)", () => {
  const fn = slice(turbo, "async function handleInitialScan", "async function handleNext");
  assert.match(fn, /result\.item\.delivery_status === 'delivered'/);
  assert.match(fn, /SCAN_PRODUCT_DELIVERED/);
  assert.match(fn, /result\.item\.delivery_status === 'cancelled'/);
  assert.match(fn, /result\.item\.delivery_status === 'not_applicable'/);
  assert.match(fn, /SCAN_PRODUCT/);
  // "delivered" NUNCA cai no branch de erro generico -- tem despacho proprio.
  const deliveredBranchIdx = fn.indexOf("result.item.delivery_status === 'delivered'");
  const nextErrorIdx = fn.indexOf("SCAN_ERROR", deliveredBranchIdx);
  const dispatchDeliveredIdx = fn.indexOf("SCAN_PRODUCT_DELIVERED", deliveredBranchIdx);
  assert.ok(dispatchDeliveredIdx !== -1 && (nextErrorIdx === -1 || dispatchDeliveredIdx < nextErrorIdx));
});

test("confirmar entrega usa o dispatcher unico deliverOperationalProductItemAction (que por tras chama deliverAdditionalStoreItemAction/deliverOrderItemProductAction conforme item.source, store.deliver, idempotente) e retorna ao leitor sozinho", () => {
  const fn = slice(turbo, "async function handleProductConfirm", "return (\n    <Chrome");
  assert.match(fn, /deliverOperationalProductItemAction\(\{ source: item\.source, item_id: item\.item_id \}\)/);
  assert.match(fn, /PRODUCT_DONE/);
  assert.match(fn, /scheduleReturn\(\)/);
});

// ============================================================
// QR por item de loja (novo) -- migration + rota de geracao
// ============================================================

test("store_order_items ganha qr_token unico com backfill e default -- nenhuma tabela nova criada", () => {
  assert.match(migration, /alter table public\.store_order_items\s*\n\s*add column if not exists qr_token text/);
  assert.match(migration, /update public\.store_order_items\s*\n\s*set qr_token =/);
  assert.match(migration, /alter column qr_token set not null/);
  assert.match(migration, /create unique index if not exists store_order_items_qr_token_key/);
  assert.doesNotMatch(migration, /create table/i);
});

test("entrega de item continua exclusivamente por deliver_store_order_item -- migration nao redefine essa RPC", () => {
  assert.doesNotMatch(migration, /create or replace function public\.deliver_store_order_item/);
});

test("rota de QR por item permite o proprietario do pedido OU store.deliver OU store.manage -- so bloqueia quem nao e nenhum dos tres -- e usa qr_token (nao order_number) como conteudo", () => {
  assert.match(itemQrRoute, /hasPermission\("store\.deliver"\)/);
  assert.match(itemQrRoute, /hasPermission\("store\.manage"\)/);
  // Autorizacao: proprietario do pedido (order.user_id === user.id) sempre pode
  // ver/gerar o QR do proprio item -- so bloqueia (403) quem nao e o dono E nao
  // tem nenhuma das duas permissoes administrativas.
  assert.match(itemQrRoute, /if \(order\?\.user_id !== user\.id && !canDeliver && !canManage\)/);
  assert.match(itemQrRoute, /data=\$\{encodeURIComponent\(String\(item\.qr_token\)\)\}/);
  assert.match(storeOrderDetailActions, /\/api\/loja\/pedidos\/\$\{storeOrderId\}\/itens\/\$\{itemId\}\/qrcode/);
});

// ============================================================
// Permissoes / acesso ao Modo Turbo
// ============================================================

test("store.grant_items nunca faz parte do fluxo Turbo -- so entrega o que ja existe", () => {
  assert.doesNotMatch(turbo, /store\.grant_items|grantStoreItemAction|admin_grant_store_item/);
  const executableSql = migration
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(executableSql, /store\.grant_items|admin_grant_store_item/);
});

test("acesso ao Turbo e exclusivamente pelo menu lateral -- Central de Operacoes nao tem mais botao/overlay proprio de Turbo", () => {
  assert.doesNotMatch(page, /showTurbo|TurboMode|onOpenTurbo|turboAvailable/);
  assert.doesNotMatch(filters, /Modo Turbo/);
});

// ============================================================
// Robustez
// ============================================================

test("processingRef evita chamada concorrente em qualquer handler que dispara uma RPC (dois scans rapidos nao duplicam operacao)", () => {
  for (const handler of ["handleInitialScan", "handleNext", "handleWristbandScan", "handleProductConfirm"]) {
    const fn = slice(turbo, `async function ${handler}(`);
    assert.match(fn.slice(0, 400), /if \(processingRef\.current\) return;/);
    assert.match(fn.slice(0, 400), /processingRef\.current = true;/);
  }
});

test("erro de rede (catch) nunca despacha sucesso -- so FAIL/SCAN_ERROR", () => {
  const catches = turbo.match(/catch \(error\) \{[\s\S]*?\}/g) ?? [];
  assert.ok(catches.length >= 4, "esperado pelo menos 4 blocos catch (scan inicial, proximo, pulseira, produto)");
  for (const block of catches) {
    assert.doesNotMatch(block, /TICKET_DONE|PRODUCT_DONE/);
  }
});

test("nenhum estado do Turbo e persistido em localStorage/sessionStorage -- F5 sempre volta pro dashboard normal (estado seguro), nunca resume um fluxo parcial", () => {
  assert.doesNotMatch(turbo, /localStorage|sessionStorage/);
  const persistedPayload = slice(page, "window.localStorage.setItem(", ");");
  assert.doesNotMatch(persistedPayload, /showTurbo/);
});

test("tipos do Modo Turbo (TurboScanResult/OperationalProductItem) sao explicitos, sem 'any'", async () => {
  const canonicalType = await readFile(new URL("../src/lib/operations/operational-product-item.ts", import.meta.url), "utf8");
  assert.match(canonicalType, /export type OperationalProductItem = \{/);
  assert.doesNotMatch(canonicalType, /:\s*any\b/);
  assert.match(types, /export type TurboScanResult =/);
  assert.doesNotMatch(slice(types, "export type TurboScanResult", "export const EMPTY_PICKUP_FILTERS"), /:\s*any\b/);
});
