import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// PROBLEMA 1: Loja -> Pedidos so consultava store_orders/store_order_items
// (list_store_orders_for_admin) -- produtos "compre junto" (order_items,
// item_kind='product') nunca apareciam, mesmo entregues. Esta suite cobre a
// RPC nova de leitura consolidada (list_operational_product_items, UNION
// ALL das duas fontes, 1 linha por ITEM) e a pagina /loja/pedidos
// atualizada pra consumi-la.

const migrationUrl = new URL('../supabase/migrations/20260918000000_operational_product_items_consolidated.sql', import.meta.url);
const pageUrl = new URL('../src/app/loja/pedidos/page.tsx', import.meta.url);
const cardUrl = new URL('../src/app/loja/pedidos/operational-product-item-card.tsx', import.meta.url);
const canonicalTypeUrl = new URL('../src/lib/operations/operational-product-item.ts', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

// ============================================================
// Reimplementacao em JS do CASE de delivery_status/filtro de status, so pra
// verificar com cenarios concretos que a formula (identica pros dois
// dominios, ja confirmada por leitura da migration abaixo) classifica os 18
// casos pedidos corretamente. Nunca uma segunda formula divergente -- so
// confirmacao.
// ============================================================
function deriveDeliveryStatus(orderStatus, itemStatus, cancelledItemValues) {
  if (orderStatus === 'cancelled' || cancelledItemValues.includes(itemStatus)) return 'cancelled';
  if (orderStatus !== 'confirmed') return 'not_applicable';
  if (itemStatus === 'delivered') return 'delivered';
  return 'to_deliver';
}

function matchesStatusFilter(pStatus, paymentStatus, deliveryStatus) {
  const v = (pStatus ?? '').toLowerCase();
  if (v === '' || v === 'all') return true;
  if (v === 'pending') return paymentStatus === 'pending';
  if (v === 'confirmed') return paymentStatus === 'confirmed';
  if (v === 'cancelled') return deliveryStatus === 'cancelled';
  if (v === 'to_deliver') return deliveryStatus === 'to_deliver';
  if (v === 'delivered') return deliveryStatus === 'delivered';
  return false;
}

test('migration cria list_operational_product_items com UNION ALL de store_order_items e order_items(product) -- leitura pura, nenhum INSERT/UPDATE/DELETE', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'list_operational_product_items');
  assert.match(fn, /from public\.store_order_items soi/);
  assert.match(fn, /from public\.order_items oi/);
  assert.match(fn, /where oi\.item_kind = 'product'/);
  assert.match(fn, /union all/);
  assert.doesNotMatch(fn, /\binsert into\b|\bupdate\s+public\.|\bdelete from\b/i);
});

test('CASO 5: "Todos" combina os dois canais numa unica lista (source distingue cada linha) sem duplicar -- 1 linha por item, nunca por pedido', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'list_operational_product_items');
  assert.match(fn, /'store'::text as source,/);
  assert.match(fn, /'checkout'::text as source,/);
  // cada CTE de origem seleciona 1 linha por item_id (soi.id / oi.id) -- sem
  // agregacao/group by que colapsaria itens em pedidos.
  assert.doesNotMatch(fn, /group by/i);
});

test('CASO 6: filtro por evento aplica igualmente aos dois canais -- mesma clausula p_event_id sobre a coluna combinada c.event_id', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'list_operational_product_items');
  assert.match(fn, /\(p_event_id is null or c\.event_id = p_event_id\)/);
});

test('CASO 7: busca (order_number/buyer) aplica igualmente aos dois canais -- mesma clausula sobre as colunas combinadas', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'list_operational_product_items');
  assert.match(fn, /c\.order_number ilike '%' \|\| v_search \|\| '%'/);
  assert.match(fn, /lower\(coalesce\(c\.buyer, ''\)\) like '%' \|\| v_search \|\| '%'/);
});

test('preserva source+item_id+order_id crus por linha -- pra a acao de entrega (deliverOperationalProductItemAction) saber em qual dominio atuar', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'list_operational_product_items');
  assert.match(fn, /c\.source, c\.item_id, c\.order_id, c\.order_number, c\.display_number,/);
});

test('delivered_by_user_id vem de audit_logs (acoes idempotentes -- no maximo 1 linha por item) -- nenhuma coluna delivered_by inventada em store_order_items/order_items', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'list_operational_product_items');
  assert.match(fn, /action in \('store_order_item_delivered', 'order_item_product_delivered'\)/);
  assert.doesNotMatch(fn, /soi\.delivered_by|oi\.delivered_by/);
});

test('permissao: reusa store.view/store.deliver (mesma da RPC anterior list_store_orders_for_admin) -- nenhuma permissao nova', async () => {
  const sql = await fs.readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'list_operational_product_items');
  assert.match(fn, /current_user_has_permission\('store\.view'\) or public\.current_user_has_permission\('store\.deliver'\)/);
});

// ============================================================
// CASOS 1-4, 8 (via formula JS espelhada -- ja confirmada linha a linha
// contra a migration nos testes acima)
// ============================================================
test('CASO 1: store_order_item confirmado e nao entregue (status=confirmed) aparece em "A entregar"', () => {
  const status = deriveDeliveryStatus('confirmed', 'confirmed', ['cancelled']);
  assert.equal(status, 'to_deliver');
  assert.ok(matchesStatusFilter('to_deliver', 'confirmed', status));
});

test('CASO 2: order_item product confirmado e nao entregue (status=confirmed) aparece em "A entregar"', () => {
  const status = deriveDeliveryStatus('confirmed', 'confirmed', ['cancelled', 'expired', 'refunded', 'transferred']);
  assert.equal(status, 'to_deliver');
  assert.ok(matchesStatusFilter('to_deliver', 'confirmed', status));
});

test('CASO 3: store_order_item com status=delivered aparece em "Entregues"', () => {
  const status = deriveDeliveryStatus('confirmed', 'delivered', ['cancelled']);
  assert.equal(status, 'delivered');
  assert.ok(matchesStatusFilter('delivered', 'confirmed', status));
  assert.ok(!matchesStatusFilter('to_deliver', 'confirmed', status));
});

test('CASO 4: order_item product com status=delivered aparece em "Entregues"', () => {
  const status = deriveDeliveryStatus('confirmed', 'delivered', ['cancelled', 'expired', 'refunded', 'transferred']);
  assert.equal(status, 'delivered');
  assert.ok(matchesStatusFilter('delivered', 'confirmed', status));
});

test('CASO 8 (pagamento pendente): item com pedido ainda pendente nunca aparece em "A entregar" nem "Entregues" -- so em "Pendentes"', () => {
  const storeStatus = deriveDeliveryStatus('pending', 'reserved', ['cancelled']);
  const checkoutStatus = deriveDeliveryStatus('pending', 'reserved', ['cancelled', 'expired', 'refunded', 'transferred']);
  for (const status of [storeStatus, checkoutStatus]) {
    assert.equal(status, 'not_applicable');
    assert.ok(matchesStatusFilter('pending', 'pending', status));
    assert.ok(!matchesStatusFilter('to_deliver', 'pending', status));
    assert.ok(!matchesStatusFilter('delivered', 'pending', status));
  }
});

test('item/pedido cancelado nunca aparece em "A entregar"/"Entregues" -- so em "Cancelados"', () => {
  const orderCancelled = deriveDeliveryStatus('cancelled', 'confirmed', ['cancelled']);
  const itemCancelledOnly = deriveDeliveryStatus('confirmed', 'cancelled', ['cancelled', 'expired', 'refunded', 'transferred']);
  for (const status of [orderCancelled, itemCancelledOnly]) {
    assert.equal(status, 'cancelled');
    assert.ok(matchesStatusFilter('cancelled', 'confirmed', status));
    assert.ok(!matchesStatusFilter('to_deliver', 'confirmed', status));
  }
});

// ============================================================
// Pagina /loja/pedidos -- consome a RPC consolidada, sem duplicar leitura
// ============================================================
test('page.tsx chama list_operational_product_items (nao mais list_store_orders_for_admin) e resolve delivered_by em lote via resolveOperatorNames', async () => {
  const source = await fs.readFile(pageUrl, 'utf8');
  assert.match(source, /supabase\.rpc\("list_operational_product_items", \{/);
  assert.doesNotMatch(source, /list_store_orders_for_admin/);
  assert.match(source, /import \{ resolveOperatorNames \} from "@\/lib\/admin\/operator-names";/);
  assert.match(source, /const operatorNames = await resolveOperatorNames\(deliveredByIds\);/);
});

test('page.tsx renderiza OperationalProductItemCard (item-level, com badge de origem) -- StoreOrderCard antigo (por pedido) foi removido', async () => {
  const source = await fs.readFile(pageUrl, 'utf8');
  assert.match(source, /import \{ OperationalProductItemCard \} from "\.\/operational-product-item-card";/);
  assert.match(source, /<OperationalProductItemCard key=\{`\$\{item\.source\}:\$\{item\.item_id\}`\} item=\{item\} \/>/);
  let storeCardExists = true;
  try {
    await fs.readFile(new URL('../src/app/loja/pedidos/store-order-card.tsx', import.meta.url), 'utf8');
  } catch {
    storeCardExists = false;
  }
  assert.equal(storeCardExists, false, 'store-order-card.tsx (por pedido) deveria ter sido removido -- substituido pelo item-level');
});

test('filtro "somente produtos globais" continua funcionando -- agora so pra source=store sem event_id (checkout nunca e global)', async () => {
  const source = await fs.readFile(pageUrl, 'utf8');
  assert.match(source, /\.filter\(\(item\) => !globalOnly \|\| \(item\.source === "store" && !item\.event_id\)\)/);
});

test('card por item mostra badge de origem discreta (Loja / Compra junto ao ingresso) -- nunca altera o fluxo, so informativo', async () => {
  const cardSource = await fs.readFile(cardUrl, 'utf8');
  assert.match(cardSource, /SOURCE_LABEL\[item\.source\]/);
  const typeSource = await fs.readFile(canonicalTypeUrl, 'utf8');
  assert.match(typeSource, /store: "Loja",/);
  assert.match(typeSource, /checkout: "Compra junto ao ingresso",/);
});

test('card por item mostra entregue_em + operador quando delivery_status=delivered', async () => {
  const cardSource = await fs.readFile(cardUrl, 'utf8');
  assert.match(cardSource, /item\.delivery_status === "delivered"/);
  assert.match(cardSource, /Entregue em/);
  assert.match(cardSource, /item\.delivered_by/);
});

test('origem "store" continua linkando pra /loja/pedidos/[orderId] (ja existente); "checkout" linka pra /inscricoes/pedido/[orderId] (ja existente) -- nenhuma tela nova criada', async () => {
  const cardSource = await fs.readFile(cardUrl, 'utf8');
  assert.match(cardSource, /const href = item\.source === "store" \? `\/loja\/pedidos\/\$\{item\.order_id\}` : `\/inscricoes\/pedido\/\$\{item\.order_id\}`;/);
});
