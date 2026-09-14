import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";
import { parseStoreOrderScanRef } from "../src/lib/operations/store-order-scan-ref.ts";

async function readFile(url, encoding = "utf8") {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  return source.slice(start, end === -1 ? undefined : end);
}

const [actions, turbo, gate] = await Promise.all([
  readFile(new URL("../src/app/operacoes/actions.ts", import.meta.url)),
  readFile(new URL("../src/app/operacoes/components/TurboMode.tsx", import.meta.url)),
  readFile(new URL("../src/lib/operations/ticket-operation-gate.ts", import.meta.url)),
]);

test("1. QR ticket ativo continua no fluxo de ingresso, sem usar registration_status", () => {
  const fn = slice(actions, "export async function resolveTurboScanAction", "export async function searchTurboOperationsAction");
  const ticketIdx = fn.indexOf('.from("tickets")');
  const productIdx = fn.indexOf("resolveOperationalScanProducts");
  assert.ok(ticketIdx !== -1 && productIdx !== -1 && ticketIdx < productIdx);
  assert.match(gate, /participants\.registration_status NÃO entra aqui/);
  assert.match(turbo, /kind: 'ticket_review'/);
});

test("2. ticket cancelado continua bloqueado por tickets.status", () => {
  assert.match(gate, /Fonte canônica de cancelamento: tickets\.status/);
  assert.match(turbo, /if \(participant\.ticket_status === 'cancelled'\) blockers\.push\('Ingresso cancelado\.'\)/);
});

test("3. QR Loja por ITEM- token continua reconhecido", () => {
  const storeFn = slice(actions, "async function resolveStoreOrderItemByQr", "async function resolveOrderItemProductByQr");
  assert.match(storeFn, /\.eq\("qr_token", tokenCandidate\)/);
});

test("4. QR equivalente ao #001121 (display e order_number do comprovante) e reconhecido", () => {
  assert.deepEqual(parseStoreOrderScanRef("#001121"), { displayNumber: 1121, orderNumber: null });
  assert.deepEqual(parseStoreOrderScanRef("001121"), { displayNumber: 1121, orderNumber: null });
  assert.deepEqual(parseStoreOrderScanRef("ADMIN-20260909-abc3bda0"), {
    displayNumber: null,
    orderNumber: "ADMIN-20260909-abc3bda0",
  });
  assert.deepEqual(parseStoreOrderScanRef("ITEM-95F7F18C8796"), { displayNumber: null, orderNumber: null });
  assert.deepEqual(parseStoreOrderScanRef("UNIT-AABBCCDDEEFF"), { displayNumber: null, orderNumber: null });
  assert.deepEqual(parseStoreOrderScanRef("a87ba37b-16ad-4a57-8992-8cd2be277962"), {
    displayNumber: null,
    orderNumber: null,
  });
  assert.match(actions, /resolveStoreOrderItemsByOrderRef/);
  assert.match(actions, /\.eq\("display_number", ref\.displayNumber\)/);
  assert.match(actions, /\.eq\("order_number", ref\.orderNumber\)/);
});

test("4b. fallback de comprovante e escopado pela org atual e recusa match ambiguo", () => {
  const fn = slice(actions, "async function resolveStoreOrderItemsByOrderRef", "async function resolveOperationalScanProducts");
  assert.match(fn, /getCurrentOrganizationContext/);
  assert.match(fn, /\.eq\("organization_id", organization\.id\)/);
  assert.match(fn, /if \(orders\.length !== 1\) return \{ status: "ambiguous" \}/);
  assert.doesNotMatch(fn, /\.eq\("event_id"/);
  assert.match(actions, /QR Code ambíguo\. Não foi possível identificar um único pedido\./);
});

test("5. item Loja ja entregue nao dispara entrega de novo", () => {
  const open = slice(turbo, "const openProduct = useCallback", "async function handleInitialScan");
  assert.match(open, /SCAN_PRODUCT_DELIVERED/);
  assert.doesNotMatch(open, /deliverOperationalProductItemAction/);
  assert.match(actions, /deliver_store_order_item/);
  assert.match(turbo, /function ProductAlreadyDelivered\(/);
});

test("6. Loja de outro evento usa mensagem especifica, nao QR invalido", () => {
  assert.match(turbo, /Este QR pertence a outro evento\./);
  const open = slice(turbo, "const openProduct = useCallback", "async function handleInitialScan");
  assert.match(open, /title: 'Outro evento'/);
  assert.doesNotMatch(open, /QR não reconhecido/);
});

test("7. QR inexistente vira invalido", () => {
  const fn = slice(actions, "export async function resolveTurboScanAction", "export async function searchTurboOperationsAction");
  assert.match(fn, /QR Code não corresponde a nenhum ingresso ou produto\./);
  assert.match(turbo, /title: 'QR não reconhecido'/);
  assert.match(turbo, /VOLTAR AO SCANNER/);
});

test("8. sem permissao identifica e nao executa", () => {
  const review = slice(turbo, "function ProductReview(", "function ProductAlreadyDelivered(");
  assert.match(review, /Você não tem permissão para entregar itens da Loja\./);
  assert.match(review, /canDeliver \? \(/);
  assert.match(review, /ENTREGAR ITEM/);
  const confirm = slice(turbo, "async function handleProductConfirm", "return (");
  assert.match(confirm, /if \(!canDeliverStoreItems\) return;/);
  const identify = slice(actions, "export async function resolveTurboScanAction", "export async function searchTurboOperationsAction");
  assert.doesNotMatch(identify, /await assertPermission\("store\.deliver"\)/);
});

test("9. leitura repetida nao duplica entrega", () => {
  const open = slice(turbo, "const openProduct = useCallback", "async function handleInitialScan");
  assert.match(open, /item\.delivery_status === 'delivered'/);
  assert.match(turbo, /kind: 'product_already_delivered'/);
});

test("10. duplo clique nao duplica entrega", () => {
  const confirm = slice(turbo, "async function handleProductConfirm", "return (");
  assert.match(confirm, /if \(processingRef\.current\) return;/);
  assert.match(confirm, /beginBusy\('ENTREGANDO\.\.\.'\)/);
  const scan = slice(turbo, "async function handleInitialScan", "async function handleNext");
  assert.match(scan, /if \(processingRef\.current\) return;/);
});

test("11. pessoa com ticket + Loja aparece como operacoes separadas na busca", () => {
  const search = slice(turbo, "function OperationSearch(", "function ProductChoices(");
  assert.match(search, /searchTurboOperationsAction/);
  assert.match(search, /Ingressos/);
  assert.match(search, /Loja/);
  assert.match(actions, /export async function searchTurboOperationsAction/);
  assert.match(actions, /hits\.push\(\{ kind: "ticket", row \}\)/);
  assert.match(actions, /hits\.push\(\{ kind: "product", item \}\)/);
});

test("12. LER PROXIMO QR limpa estado", () => {
  assert.match(turbo, /case 'RESET':\s*\n\s*return \{ kind: 'scanning_initial' \};/);
  assert.match(turbo, /dispatch\(\{ type: 'RESET' \}\)/);
  assert.match(turbo, /LER PRÓXIMO QR/);
  assert.match(turbo, /processingRef\.current = false/);
});
