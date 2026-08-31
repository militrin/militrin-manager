import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// BUG: QR de produto "compre junto" (order_items.qr_token, formato
// ITEM-xxxxxxxxxxxx) nao funcionava na Central de Operacoes nem no Modo
// Turbo -- nenhum dos dois leitores sabia procurar por order_items ainda
// (so tickets.token e, no Turbo, store_order_items.qr_token). Nenhum dos
// dois dominios de QR pode confundir o outro; nenhum deles pode tratar o
// token escaneado como uuid (order_items.qr_token e store_order_items.
// qr_token sao colunas TEXT -- comparar com .eq("qr_token", tokenCandidate)
// nunca tenta um cast, so .eq("id", tokenCandidate) tentaria).

const migrationUrl = new URL('../supabase/migrations/20260917000000_order_item_product_delivery.sql', import.meta.url);
const actionsUrl = new URL('../src/app/operacoes/actions.ts', import.meta.url);
const typesUrl = new URL('../src/app/operacoes/types.ts', import.meta.url);
const turboModeUrl = new URL('../src/app/operacoes/components/TurboMode.tsx', import.meta.url);
const pageUrl = new URL('../src/app/operacoes/page.tsx', import.meta.url);
const modalUrl = new URL('../src/app/operacoes/components/OrderItemProductQrModal.tsx', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

function extractTsFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`funcao ${name} nao encontrada em ${source.slice(0, 40)}...`);
  // Fecha no proximo "\n}\n" no mesmo nivel -- suficiente pra estas funcoes
  // (nenhuma delas tem chave de fechamento de bloco solta numa linha propria
  // antes do fim real, confirmado por leitura).
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end === -1 ? undefined : end + 2);
}

// ============================================================
// CASO 4 (nucleo do bug): token ITEM-* nunca e tratado como UUID
// ============================================================
test('CASO 4: resolveOrderItemProductByQr busca por qr_token (coluna TEXT), nunca por id (uuid) -- token escaneado nunca sofre cast', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fn = extractTsFunction(source, 'resolveOrderItemProductByQr');
  assert.match(fn, /\.eq\("qr_token", tokenCandidate\)/);
  assert.doesNotMatch(fn, /\.eq\("id",\s*tokenCandidate\)/);
});

test('CASO 4: resolveTurboStoreItemByQr (dominio store_order_items, ja existente) continua buscando por qr_token, nunca por id -- garantia preservada, nao so a nova', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fn = extractTsFunction(source, 'resolveTurboStoreItemByQr');
  assert.match(fn, /\.eq\("qr_token", tokenCandidate\)/);
  assert.doesNotMatch(fn, /\.eq\("id",\s*tokenCandidate\)/);
});

test('CASO 4: isUuid() so e aplicado ao order_item_id JA RESOLVIDO pelo backend (deliverOrderItemProductAction), nunca ao valor bruto escaneado', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fn = extractTsFunction(source, 'deliverOrderItemProductAction');
  assert.match(fn, /if \(!isUuid\(orderItemId\)\) return \{ success: false, message: "Identificador inválido\." \};/);
});

// ============================================================
// CASO 3: QR de order_items product e reconhecido (resolucao)
// ============================================================
test('CASO 3: resolveOrderItemProductByQr filtra item_kind=product e resolve produto/variante/quantidade/pedido/evento/comprador', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fn = extractTsFunction(source, 'resolveOrderItemProductByQr');
  assert.match(fn, /\.eq\("item_kind", "product"\)/);
  assert.match(fn, /from\("order_items"\)/);
  assert.match(fn, /get_operation_buyers/);
  assert.match(fn, /kind: "order_item_product"/);
});

// ============================================================
// CASO 7: quantidade 2 permanece uma linha/um QR (le direto de order_items.quantity, nunca sintetiza)
// ============================================================
test('CASO 7: resolveOrderItemProductByQr le quantity diretamente da linha (1 linha = 1 token = a quantidade real da linha, nunca 1 por unidade)', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fn = extractTsFunction(source, 'resolveOrderItemProductByQr');
  assert.match(fn, /quantity: Number\(line\.quantity \?\? 1\)/);
  assert.match(fn, /\.limit\(1\)\s*\n\s*\.maybeSingle\(\);/);
});

// ============================================================
// CASO 11: evento derivado do proprio order_item/order -- nunca exigido do cliente
// ============================================================
test('CASO 11: resolveOrderItemProductByQr NAO recebe event_id como parametro -- o evento vem de order_items.event_id, ja resolvido pelo backend', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fnStart = source.indexOf('async function resolveOrderItemProductByQr(');
  const signature = source.slice(fnStart, source.indexOf(')', fnStart) + 1);
  assert.doesNotMatch(signature, /event_id|eventId/i);
  const fn = extractTsFunction(source, 'resolveOrderItemProductByQr');
  assert.match(fn, /event_id: String\(line\.event_id\)/);
});

test('CASO 11: deliver_order_item_product (RPC) recebe SOMENTE p_order_item_id -- nunca um event_id do cliente pra decidir o que entregar', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_order_item_product');
  assert.match(sql, /create or replace function public\.deliver_order_item_product\(p_order_item_id uuid\)/);
  assert.doesNotMatch(fn, /p_event_id/);
});

// ============================================================
// CASO 5/6: Turbo abre a revisao do produto; Central abre o fluxo correto
// ============================================================
test('CASO 5: TurboMode.tsx tem uma tela propria (order_item_product_review) pra order_items -- nunca reaproveita product_review (store_order_items)', async () => {
  const source = await fs.readFile(turboModeUrl, 'utf8');
  assert.match(source, /kind: 'order_item_product_review'; item: OrderItemProductDetails/);
  assert.match(source, /case 'SCAN_ORDER_ITEM_PRODUCT':\s*\n\s*return \{ kind: 'order_item_product_review', item: action\.item \};/);
  assert.match(source, /screen\.kind === 'order_item_product_review'/);
  assert.match(source, /function OrderItemProductReview\(/);
});

test('CASO 5: handleInitialScan bloqueia produto pendente/entregue/cancelado ANTES de abrir a revisao, mas so despacha SCAN_ORDER_ITEM_PRODUCT quando o item pode ser entregue', async () => {
  const source = await fs.readFile(turboModeUrl, 'utf8');
  const fnStart = source.indexOf('async function handleInitialScan(');
  const fnEnd = source.indexOf('\n  async function handleNext(');
  const fn = source.slice(fnStart, fnEnd);
  assert.match(fn, /if \(result\.item\.status === 'delivered'\) \{\s*\n\s*dispatch\(\{ type: 'SCAN_ERROR', title: 'Produto já entregue'/);
  assert.match(fn, /dispatch\(\{ type: 'SCAN_ORDER_ITEM_PRODUCT', item: result\.item \}\);/);
});

test('CASO 6: page.tsx (Central) abre OrderItemProductQrModal quando o QR resolve pra order_item_product -- NUNCA cai no branch de ingresso (participant.kind !== "ticket")', async () => {
  const source = await fs.readFile(pageUrl, 'utf8');
  const fnStart = source.indexOf('async function handleQrRead(');
  const fnEnd = source.indexOf('\n  async function handleEventChange(');
  const fn = source.slice(fnStart, fnEnd);
  const productBranchIdx = fn.indexOf('response.participant.kind === "order_item_product"');
  const ticketBranchIdx = fn.indexOf('participant.kind !== "ticket"');
  assert.ok(productBranchIdx !== -1 && ticketBranchIdx !== -1 && productBranchIdx < ticketBranchIdx, 'o branch de produto precisa ser checado ANTES do branch de ingresso, com return proprio');
  assert.match(fn, /setOrderItemProductModal\(response\.participant\);/);
  assert.match(source, /import \{ OrderItemProductQrModal \} from "\.\/components\/OrderItemProductQrModal";/);
});

test('CASO 6: Central nunca abre a tabela/foco de participante pra um produto -- insertAndFocusTicket so e chamado no branch de ingresso', async () => {
  const source = await fs.readFile(pageUrl, 'utf8');
  const fnStart = source.indexOf('async function handleQrRead(');
  const fnEnd = source.indexOf('\n  async function handleEventChange(');
  const fn = source.slice(fnStart, fnEnd);
  const productBranch = fn.slice(fn.indexOf('response.participant.kind === "order_item_product"'), fn.indexOf('const participant = response.participant as PickupDetails;'));
  assert.doesNotMatch(productBranch, /insertAndFocusTicket/);
});

// ============================================================
// CASO 10: evento diferente -- Central e Turbo validam DEPOIS de resolver
// ============================================================
test('CASO 10: Turbo valida evento do produto DEPOIS de resolver o QR (nunca antes) -- mesmo padrao ja usado pro ingresso', async () => {
  const source = await fs.readFile(turboModeUrl, 'utf8');
  const fnStart = source.indexOf('async function handleInitialScan(');
  const fnEnd = source.indexOf('\n  async function handleNext(');
  const fn = source.slice(fnStart, fnEnd);
  const resolveIdx = fn.indexOf('const result = await resolveTurboScanAction(raw);');
  const eventCheckIdx = fn.indexOf("result.item.event_id !== event.id");
  assert.ok(resolveIdx !== -1 && eventCheckIdx !== -1 && resolveIdx < eventCheckIdx, 'a checagem de evento do produto deveria acontecer DEPOIS da resolucao do QR');
  assert.match(fn, /title: 'Evento diferente'/);
});

test('CASO 10: Central valida evento do produto DEPOIS de resolver o QR (nunca antes)', async () => {
  const source = await fs.readFile(pageUrl, 'utf8');
  const fnStart = source.indexOf('async function handleQrRead(');
  const fnEnd = source.indexOf('\n  async function handleEventChange(');
  const fn = source.slice(fnStart, fnEnd);
  const resolveIdx = fn.indexOf('const response = await searchPickupParticipantByQrAction(value);');
  const eventCheckIdx = fn.indexOf('response.participant.event_id !== selectedEvent?.id');
  assert.ok(resolveIdx !== -1 && eventCheckIdx !== -1 && resolveIdx < eventCheckIdx);
});

// ============================================================
// CASO 8/9: pagamento pendente bloqueia; ja entregue e idempotente
// ============================================================
test('CASO 8: deliver_order_item_product exige status=confirmed (pago) antes de entregar -- reserved (pendente) e rejeitado com mensagem clara', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_order_item_product');
  assert.match(fn, /if v_item\.status <> 'confirmed' then raise exception 'Item precisa estar confirmado \(pago\) para ser entregue\.'; end if;/);
});

test('CASO 9: deliver_order_item_product e IDEMPOTENTE -- item ja delivered retorna true sem re-executar baixa de estoque nem duplicar auditoria', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_order_item_product');
  const idempotentIdx = fn.indexOf("if v_item.status = 'delivered' then return true; end if;");
  const stockIdx = fn.indexOf('perform public.deliver_store_item_stock');
  assert.ok(idempotentIdx !== -1 && stockIdx !== -1 && idempotentIdx < stockIdx, 'o retorno idempotente precisa acontecer ANTES de qualquer baixa de estoque/auditoria');
});

test('CASO 9: Turbo tambem bloqueia re-entrega na UI (item ja entregue nunca chega na tela de confirmar) -- reforca o idempotente do backend, nao o substitui', async () => {
  const source = await fs.readFile(turboModeUrl, 'utf8');
  const fnStart = source.indexOf('async function handleInitialScan(');
  const fnEnd = source.indexOf('\n  async function handleNext(');
  const fn = source.slice(fnStart, fnEnd);
  const deliveredChecks = fn.match(/status === 'delivered'/g) ?? [];
  assert.equal(deliveredChecks.length, 2, 'deveria bloquear "ja entregue" tanto pro store_item quanto pro order_item_product');
});

// ============================================================
// CASO 12: auditoria
// ============================================================
test('CASO 12: deliver_order_item_product registra auditoria (audit_logs) com actor, pedido e item -- mesmo padrao ja usado por deliver_store_order_item', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_order_item_product');
  assert.match(fn, /insert into public\.audit_logs\(action, entity_type, entity_id, event_id, details\)/);
  assert.match(fn, /values\('order_item_product_delivered', 'order_items', v_item\.id, v_item\.event_id, jsonb_build_object\(/);
  assert.match(fn, /'actor_user_id', auth\.uid\(\)/);
});

// ============================================================
// Autorizacao: reusa store.deliver (permissao canonica ja existente) --
// nenhuma permissao nova criada
// ============================================================
test('deliver_order_item_product reusa store.deliver (mesma permissao ja usada por deliver_store_order_item) -- nenhuma permissao nova criada', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_order_item_product');
  assert.match(fn, /current_user_has_permission\('store\.deliver'\)/);
  assert.doesNotMatch(sql, /'store\.deliver_product'|'products\.deliver'|'order_items\.deliver'/);
});

test('deliverOrderItemProductAction (server action) exige store.deliver -- mesma permissao de deliverAdditionalStoreItemAction', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fn = extractTsFunction(source, 'deliverOrderItemProductAction');
  assert.match(fn, /await assertPermission\("store\.deliver"\);/);
});

test('resolveTurboScanAction so exige store.deliver DEPOIS de confirmar que o QR resolveu pra um produto order_items -- mesmo raciocinio ja usado pro store_item', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fnStart = source.indexOf('export async function resolveTurboScanAction(');
  const fnEnd = source.indexOf('\nexport async function deliverKitCheckinAndLinkWristbandAction(');
  const fn = source.slice(fnStart, fnEnd);
  const resolveIdx = fn.indexOf('const orderItemProduct = await resolveOrderItemProductByQr(supabase, tokenCandidate);');
  const permissionIdx = fn.indexOf('if (orderItemProduct) {');
  assert.ok(resolveIdx !== -1 && permissionIdx !== -1 && resolveIdx < permissionIdx);
  const productBranch = fn.slice(permissionIdx, fn.indexOf('return { success: false, message: "QR Code não corresponde'));
  assert.match(productBranch, /await assertPermission\("store\.deliver"\);/);
});

// ============================================================
// CASO 1/2: ingresso e store_order_items continuam funcionando (nada regrediu)
// ============================================================
test('CASO 1: resolveTurboScanAction e searchPickupParticipantByQrAction continuam resolvendo ingresso por tickets.token PRIMEIRO, sem nenhuma mudanca de ordem', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const turboFn = source.slice(source.indexOf('export async function resolveTurboScanAction('), source.indexOf('\nexport async function deliverKitCheckinAndLinkWristbandAction('));
  const pickupFn = source.slice(source.indexOf('export async function searchPickupParticipantByQrAction('), source.indexOf('\nfunction validateReasonPayload('));
  for (const fn of [turboFn, pickupFn]) {
    assert.match(fn, /from\("tickets"\)\s*\n\s*\.select\("id"\)\s*\n\s*\.eq\("token", tokenCandidate\)/);
  }
});

test('CASO 2: resolveTurboStoreItemByQr (store_order_items) permanece intocada -- ainda a segunda tentativa de resolucao no Turbo, antes de order_items', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fnStart = source.indexOf('export async function resolveTurboScanAction(');
  const fnEnd = source.indexOf('\nexport async function deliverKitCheckinAndLinkWristbandAction(');
  const fn = source.slice(fnStart, fnEnd);
  const storeItemIdx = fn.indexOf('const item = await resolveTurboStoreItemByQr(supabase, tokenCandidate);');
  const orderItemIdx = fn.indexOf('const orderItemProduct = await resolveOrderItemProductByQr(supabase, tokenCandidate);');
  assert.ok(storeItemIdx !== -1 && orderItemIdx !== -1 && storeItemIdx < orderItemIdx, 'store_order_items continua sendo tentado ANTES de order_items -- nenhuma reordenacao que pudesse mudar comportamento existente');
});

// ============================================================
// Coluna/RPC nao vazam mais dado do que o necessario (modal so mostra o
// que a UX pediu, nunca qr_token cru)
// ============================================================
test('OrderItemProductQrModal nunca expoe qr_token -- so os campos de revisao (produto/variante/quantidade/pedido/comprador/evento/status)', async () => {
  const source = await fs.readFile(modalUrl, 'utf8');
  assert.doesNotMatch(source, /qr_token/);
  assert.match(source, /item\.order_number/);
  assert.match(source, /item\.buyer_name/);
  assert.match(source, /item\.event_name/);
  assert.match(source, /deliverOrderItemProductAction\(item\.order_item_id\)/);
});

test('OrderItemProductQrModal so mostra "Confirmar entrega" quando status=confirmed -- pendente/entregue/cancelado nunca oferecem o botao', async () => {
  const source = await fs.readFile(modalUrl, 'utf8');
  assert.match(source, /const canDeliver = item\.status === "confirmed";/);
  assert.match(source, /\{canDeliver \? \(/);
});

// ============================================================
// types.ts -- abstracao segura, sem perder a origem
// ============================================================
test('types.ts: OrderItemProductDetails carrega kind proprio (nunca reaproveita TurboStoreItemDetails) -- os dois dominios nunca se confundem no tipo', async () => {
  const source = await fs.readFile(typesUrl, 'utf8');
  assert.match(source, /export type OrderItemProductDetails = \{\s*\n\s*kind: "order_item_product";/);
  assert.match(source, /\| \{ success: true; kind: "order_item_product"; item: OrderItemProductDetails \}/);
});
