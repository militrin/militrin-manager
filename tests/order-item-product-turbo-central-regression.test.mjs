import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// AJUSTE OPERACIONAL: produtos vendidos pela loja standalone (store_orders/
// store_order_items) e "compre junto" no checkout de ingresso (orders/
// order_items, item_kind='product') sao UM UNICO FLUXO OPERACIONAL pro
// operador -- Central de Operacoes e Modo Turbo resolvem os dois canais
// atraves da MESMA interface canonica (OperationalProductItem, src/lib/
// operations/operational-product-item.ts), nunca "if store_item / else
// order_item_product" espalhado pela UI. As tabelas continuam separadas
// (nada migrado, nada duplicado) -- so a camada de leitura/acao e unificada.
//
// Cobre tambem: segunda leitura de QR ja entregue abre um RESUMO da entrega
// (nunca so um erro que reseta o leitor), idempotencia (nunca reprocessa
// estoque/entrega), e o token escaneado nunca e tratado como uuid.

const migrationsDirUrl = new URL('../supabase/migrations/', import.meta.url);
const deliveryMigrationUrl = new URL('../supabase/migrations/20260917000000_order_item_product_delivery.sql', import.meta.url);
const actionsUrl = new URL('../src/app/operacoes/actions.ts', import.meta.url);
const typesUrl = new URL('../src/app/operacoes/types.ts', import.meta.url);
const turboModeUrl = new URL('../src/app/operacoes/components/TurboMode.tsx', import.meta.url);
const pageUrl = new URL('../src/app/operacoes/page.tsx', import.meta.url);
const modalUrl = new URL('../src/app/operacoes/components/OperationalProductItemModal.tsx', import.meta.url);
const canonicalTypeUrl = new URL('../src/lib/operations/operational-product-item.ts', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

async function resolveCurrentFunctionDefinition(functionName) {
  const files = (await fs.readdir(migrationsDirUrl)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const pattern = new RegExp(`create (?:or replace )?function public\\.${functionName}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  let source = null;
  let definedInFile = null;
  for (const file of files) {
    const sql = await fs.readFile(new URL(file, migrationsDirUrl), 'utf8');
    const match = sql.match(pattern);
    if (match) {
      source = match[0];
      definedInFile = file;
    }
  }
  if (!source) throw new Error(`funcao ${functionName} nunca foi definida em nenhuma migration`);
  return { source, definedInFile };
}

function extractTsFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`funcao ${name} nao encontrada`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end === -1 ? undefined : end + 2);
}

// ============================================================
// Interface canonica: OperationalProductItem
// ============================================================
test('OperationalProductItem carrega source+item_id+order_id explicitos (nunca inferidos) -- e o formato unico consumido por Turbo, Central e Loja -> Pedidos', async () => {
  const source = await fs.readFile(canonicalTypeUrl, 'utf8');
  assert.match(source, /source: "store" \| "checkout";/);
  assert.match(source, /item_id: string;/);
  assert.match(source, /order_id: string;/);
  assert.match(source, /delivered_by: string \| null;/);
});

test('types.ts (operacoes) reexporta OperationalProductItem -- TurboScanResult usa kind="product" unico (nunca mais "store_item"/"order_item_product" separados)', async () => {
  const source = await fs.readFile(typesUrl, 'utf8');
  assert.match(source, /export type \{ OperationalProductItem \} from "@\/lib\/operations\/operational-product-item";/);
  assert.match(source, /\| \{ success: true; kind: "product"; item: OperationalProductItem \}/);
  assert.doesNotMatch(source, /kind: "store_item"|kind: "order_item_product"/);
});

// ============================================================
// Token nunca tratado como UUID (nucleo do bug original)
// ============================================================
test('resolveStoreOrderItemByQr e resolveOrderItemProductByQr resolvem SEMPRE por qr_token (coluna TEXT) -- nunca por id (uuid)', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const storeFn = extractTsFunction(source, 'resolveStoreOrderItemByQr');
  const checkoutFn = extractTsFunction(source, 'resolveOrderItemProductByQr');
  for (const fn of [storeFn, checkoutFn]) {
    assert.match(fn, /\.eq\("qr_token", tokenCandidate\)/);
    assert.doesNotMatch(fn, /\.eq\("id",\s*tokenCandidate\)/);
  }
});

test('isUuid() so e aplicado a ids JA RESOLVIDOS pelo backend (deliverOrderItemProductAction/deliverAdditionalStoreItemAction), nunca ao valor bruto escaneado', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fn = extractTsFunction(source, 'deliverOrderItemProductAction');
  assert.match(fn, /if \(!isUuid\(orderItemId\)\) return \{ success: false, message: "Identificador inválido\." \};/);
});

// ============================================================
// Resolucao unificada -- um so ponto de entrada, tenta os dois canais
// ============================================================
test('resolveOperationalProductByQr tenta loja standalone primeiro, depois "compre junto" -- reusado por Turbo E Central (nenhuma resolucao duplicada)', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fn = extractTsFunction(source, 'resolveOperationalProductByQr');
  assert.match(fn, /const storeItem = await resolveStoreOrderItemByQr\(supabase, tokenCandidate\);/);
  assert.match(fn, /return resolveOrderItemProductByQr\(supabase, tokenCandidate\);/);
  const storeIdx = fn.indexOf('resolveStoreOrderItemByQr');
  const checkoutIdx = fn.indexOf('resolveOrderItemProductByQr');
  assert.ok(storeIdx < checkoutIdx);

  const turboFnStart = source.indexOf('export async function resolveTurboScanAction(');
  const turboFnEnd = source.indexOf('\nexport async function deliverKitCheckinAndLinkWristbandAction(');
  const turboFn = source.slice(turboFnStart, turboFnEnd);
  assert.match(turboFn, /resolveOperationalProductByQr\(supabase, tokenCandidate\)/);

  const centralFnStart = source.indexOf('export async function searchPickupParticipantByQrAction(');
  const centralFnEnd = source.indexOf('\nfunction validateReasonPayload(');
  const centralFn = source.slice(centralFnStart, centralFnEnd);
  assert.match(centralFn, /resolveOperationalProductByQr\(supabase, tokenCandidate\)/);
});

test('deliverOperationalProductItemAction e o UNICO ponto de entrega chamado pela UI (Turbo e Central) -- roteia pelo source, nunca a UI decide qual RPC chamar', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const dispatcherStart = source.indexOf('export async function deliverOperationalProductItemAction(');
  const dispatcherEnd = source.indexOf('\n}', dispatcherStart);
  const dispatcher = source.slice(dispatcherStart, dispatcherEnd);
  assert.match(dispatcher, /if \(item\.source === "store"\) return deliverAdditionalStoreItemAction\(item\.item_id\);/);
  assert.match(dispatcher, /return deliverOrderItemProductAction\(item\.item_id\);/);

  const turboSource = await fs.readFile(turboModeUrl, 'utf8');
  assert.match(turboSource, /deliverOperationalProductItemAction\(\{ source: item\.source, item_id: item\.item_id \}\)/);
  assert.doesNotMatch(turboSource, /deliverAdditionalStoreItemAction\(|deliverOrderItemProductAction\(/);

  const modalSource = await fs.readFile(modalUrl, 'utf8');
  assert.match(modalSource, /deliverOperationalProductItemAction\(\{ source: item\.source, item_id: item\.item_id \}\)/);
});

// ============================================================
// Evento derivado do item, nunca exigido do cliente pra resolver o QR
// ============================================================
test('resolveOperationalProductByQr/resolveOperationTurboScanAction nunca recebem event_id como parametro de entrada -- so validado DEPOIS de resolver', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const signature = source.slice(source.indexOf('async function resolveOperationalProductByQr('), source.indexOf(')', source.indexOf('async function resolveOperationalProductByQr(')) + 1);
  assert.doesNotMatch(signature, /event_id|eventId/i);
});

test('Turbo e Central validam evento do produto DEPOIS de resolver (event_id pode ser null -- produto global da loja -- nunca bloqueia nesse caso)', async () => {
  const turboSource = await fs.readFile(turboModeUrl, 'utf8');
  const turboFn = turboSource.slice(turboSource.indexOf('async function handleInitialScan('), turboSource.indexOf('\n  async function handleNext('));
  const turboResolveIdx = turboFn.indexOf('const result = await resolveTurboScanAction(raw);');
  const turboEventCheckIdx = turboFn.indexOf('result.item.event_id && result.item.event_id !== event.id');
  assert.ok(turboResolveIdx !== -1 && turboEventCheckIdx !== -1 && turboResolveIdx < turboEventCheckIdx);

  const pageSource = await fs.readFile(pageUrl, 'utf8');
  const pageFn = pageSource.slice(pageSource.indexOf('async function handleQrRead('), pageSource.indexOf('\n  async function handleEventChange('));
  const pageResolveIdx = pageFn.indexOf('const response = await searchPickupParticipantByQrAction(value);');
  const pageEventCheckIdx = pageFn.indexOf('response.item.event_id && response.item.event_id !== selectedEvent?.id');
  assert.ok(pageResolveIdx !== -1 && pageEventCheckIdx !== -1 && pageResolveIdx < pageEventCheckIdx);
});

// ============================================================
// Segunda leitura: resumo da entrega (nunca so um erro que reseta o leitor)
// ============================================================
test('Turbo: delivery_status="delivered" abre a tela de resumo (product_already_delivered) -- NUNCA um SCAN_ERROR generico', async () => {
  const source = await fs.readFile(turboModeUrl, 'utf8');
  const fn = source.slice(source.indexOf('async function handleInitialScan('), source.indexOf('\n  async function handleNext('));
  assert.match(fn, /if \(result\.item\.delivery_status === 'delivered'\) \{\s*\n[\s\S]*?dispatch\(\{ type: 'SCAN_PRODUCT_DELIVERED', item: result\.item \}\);/);
  assert.match(source, /case 'SCAN_PRODUCT_DELIVERED':\s*\n\s*return \{ kind: 'product_already_delivered', item: action\.item \};/);
  assert.match(source, /function ProductAlreadyDelivered\(/);
});

test('Turbo: tela de resumo mostra produto/quantidade/variante/pedido/comprador/evento/data-hora/operador/status, com botao "Voltar ao leitor" que reseta pro scanner', async () => {
  const source = await fs.readFile(turboModeUrl, 'utf8');
  const fn = source.slice(source.indexOf('function ProductAlreadyDelivered('), source.indexOf('function InfoTile('));
  assert.match(fn, /Item já entregue/);
  assert.match(fn, /item\.quantity\}x \{item\.product_name\}/);
  assert.match(fn, /item\.variant/);
  assert.match(fn, /label="Pedido" value=\{item\.order_reference\}/);
  assert.match(fn, /label="Comprador" value=\{item\.buyer\}/);
  assert.match(fn, /label="Evento" value=\{item\.event_name\}/);
  assert.match(fn, /Primeira entrega/);
  assert.match(fn, /item\.delivered_at \? new Date\(item\.delivered_at\)\.toLocaleString\('pt-BR'\)/);
  assert.match(fn, /Operador/);
  assert.match(fn, /item\.delivered_by \?\? 'Não identificado'/);
  assert.match(fn, /<BigButton onClick=\{onBack\}>Voltar ao leitor<\/BigButton>/);
  // onBack = backToScanner, que despacha RESET -- volta pro leitor de verdade.
  assert.match(source, /onBack=\{backToScanner\}/);
});

test('Central: modal unico mostra resumo quando ja entregue, formulario de confirmar quando "a entregar", e so status quando nao aplicavel -- NUNCA um popup generico', async () => {
  const source = await fs.readFile(modalUrl, 'utf8');
  assert.match(source, /const alreadyDelivered = item\.delivery_status === "delivered";/);
  assert.match(source, /const canDeliver = item\.delivery_status === "to_deliver";/);
  assert.match(source, /Primeira entrega/);
  assert.match(source, /item\.delivered_by \?\? "Não identificado"/);
  assert.match(source, /\{alreadyDelivered \? "Voltar ao leitor" : "Fechar"\}/);
});

// ============================================================
// Idempotencia (backend) -- reafirma que a leitura nunca reprocessa
// ============================================================
test('deliver_order_item_product continua idempotente: status=delivered retorna true ANTES de qualquer baixa de estoque/update/audit -- nenhuma mudanca nesta migration', async () => {
  const { source, definedInFile } = await resolveCurrentFunctionDefinition('deliver_order_item_product');
  assert.equal(definedInFile, '20260917000000_order_item_product_delivery.sql');
  const idempotentIdx = source.indexOf("if v_item.status = 'delivered' then return true; end if;");
  const stockIdx = source.indexOf('perform public.deliver_store_item_stock');
  assert.ok(idempotentIdx !== -1 && stockIdx !== -1 && idempotentIdx < stockIdx);
});

test('deliver_order_item_product nunca sobrescreve delivered_at/status em quem ja esta delivered -- o UPDATE so roda no branch que passou pela checagem de status=confirmed', async () => {
  const sql = await fs.readFile(deliveryMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_order_item_product');
  assert.match(fn, /if v_item\.status <> 'confirmed' then raise exception 'Item precisa estar confirmado \(pago\) para ser entregue\.'; end if;/);
  const guardIdx = fn.indexOf("if v_item.status <> 'confirmed'");
  const updateIdx = fn.indexOf('update public.order_items set status');
  assert.ok(guardIdx !== -1 && updateIdx !== -1 && guardIdx < updateIdx);
});

// ============================================================
// Operador da PRIMEIRA entrega -- resolvido via audit_logs, nunca inventado
// ============================================================
test('resolveDeliveredByName le audit_logs (nao uma coluna delivered_by que nao existe) e reusa resolveOperatorNames (unico resolvedor canonico de operador) -- nunca o usuario atual', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const fn = extractTsFunction(source, 'resolveDeliveredByName');
  assert.match(fn, /from\("audit_logs"\)/);
  assert.match(fn, /\.eq\("action", action\)/);
  assert.match(fn, /\.eq\("entity_id", itemId\)/);
  assert.match(fn, /resolveOperatorNames\(\[actorUserId\]\)/);
  assert.doesNotMatch(fn, /auth\.getUser\(\)|current.*user.*id/i);
});

test('resolveStoreOrderItemByQr/resolveOrderItemProductByQr so chamam resolveDeliveredByName quando delivery_status="delivered" -- nunca resolvem operador pra item ainda nao entregue', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const storeFn = extractTsFunction(source, 'resolveStoreOrderItemByQr');
  const checkoutFn = extractTsFunction(source, 'resolveOrderItemProductByQr');
  assert.match(storeFn, /delivered_by: deliveryStatus === "delivered" \? await resolveDeliveredByName\(supabase, "store_order_item_delivered", String\(line\.id\)\) : null,/);
  assert.match(checkoutFn, /delivered_by: deliveryStatus === "delivered" \? await resolveDeliveredByName\(supabase, "order_item_product_delivered", String\(line\.id\)\) : null,/);
});

// ============================================================
// Autorizacao preservada -- store.deliver continua a permissao canonica
// ============================================================
test('store.deliver continua a unica permissao de entrega -- nenhuma permissao nova, nenhum enfraquecimento', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const turboFnStart = source.indexOf('export async function resolveTurboScanAction(');
  const turboFnEnd = source.indexOf('\nexport async function deliverKitCheckinAndLinkWristbandAction(');
  const turboFn = source.slice(turboFnStart, turboFnEnd);
  assert.match(turboFn, /await assertPermission\("store\.deliver"\);/);
  const dispatcherSource = await fs.readFile(actionsUrl, 'utf8');
  assert.match(dispatcherSource, /export async function deliverOrderItemProductAction\(orderItemId: string\) \{\s*\n\s*await assertPermission\("store\.deliver"\);/);
});

// ============================================================
// Ingresso (ticket) continua funcionando sem regressao
// ============================================================
test('ingresso: resolveTurboScanAction e searchPickupParticipantByQrAction continuam resolvendo por tickets.token PRIMEIRO, sem nenhuma mudanca de ordem ou comportamento', async () => {
  const source = await fs.readFile(actionsUrl, 'utf8');
  const turboFn = source.slice(source.indexOf('export async function resolveTurboScanAction('), source.indexOf('\nexport async function deliverKitCheckinAndLinkWristbandAction('));
  const centralFn = source.slice(source.indexOf('export async function searchPickupParticipantByQrAction('), source.indexOf('\nfunction validateReasonPayload('));
  for (const fn of [turboFn, centralFn]) {
    assert.match(fn, /from\("tickets"\)\s*\n\s*\.select\("id"\)\s*\n\s*\.eq\("token", tokenCandidate\)/);
    assert.match(fn, /kind: "ticket"/);
  }
});
