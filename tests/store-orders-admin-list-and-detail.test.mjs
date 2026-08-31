import assert from "node:assert/strict";
import { readFile as readFileRaw } from "node:fs/promises";
import test from "node:test";

async function readFile(url, encoding) {
  return (await readFileRaw(url, encoding)).replace(/\r\n/g, "\n");
}

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marcador nao encontrado: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  assert.notEqual(end, -1, `marcador de fim nao encontrado: ${endMarker}`);
  return source.slice(start, end);
}

const migration = await readFile(new URL("../supabase/migrations/20260869000000_store_orders_admin_listing_and_detail.sql", import.meta.url), "utf8");
const lojaPage = await readFile(new URL("../src/app/loja/page.tsx", import.meta.url), "utf8");
const subNav = await readFile(new URL("../src/app/loja/store-sub-nav.tsx", import.meta.url), "utf8");
const ordersListPage = await readFile(new URL("../src/app/loja/pedidos/page.tsx", import.meta.url), "utf8");
// store-order-card.tsx (por PEDIDO) foi substituido por
// operational-product-item-card.tsx (por ITEM, consolidando loja standalone
// e "compre junto" -- ver operational-product-items-listing-regression.test.mjs
// pra cobertura completa da consolidacao). Continua sendo "o card da
// listagem" pros propositos deste arquivo.
const orderCard = await readFile(new URL("../src/app/loja/pedidos/operational-product-item-card.tsx", import.meta.url), "utf8");
const orderDetailPage = await readFile(new URL("../src/app/loja/pedidos/[orderId]/page.tsx", import.meta.url), "utf8");
const orderDetailActions = await readFile(new URL("../src/app/loja/pedidos/[orderId]/order-detail-actions.tsx", import.meta.url), "utf8");
const lojaActions = await readFile(new URL("../src/app/loja/actions.ts", import.meta.url), "utf8");

// ── Submenu ──────────────────────────────────────────────────────────────

test("submenu da Loja tem Produtos e Pedidos, com active state, e /loja passa a mostrar o submenu", () => {
  assert.match(subNav, /\['produtos', 'Produtos', '\/loja'\]/);
  assert.match(subNav, /\['pedidos', 'Pedidos', '\/loja\/pedidos'\]/);
  assert.match(subNav, /active === code/);
  assert.match(lojaPage, /<StoreSubNav active="produtos" \/>/);
  assert.match(ordersListPage, /<StoreSubNav active="pedidos" \/>/);
});

test("/loja (produtos) nao tem mais a secao de pedidos antiga (substituida por /loja/pedidos) -- nao ha duas fontes de pedidos divergentes", () => {
  assert.doesNotMatch(lojaPage, /StoreOrdersList/);
  assert.doesNotMatch(lojaPage, /from\("store_orders"\)/);
});

// ── Fonte canonica da listagem: RPC nova, sem tabela paralela ───────────────

test("list_store_orders_for_admin reaproveita store_orders/store_order_items -- nenhuma tabela nova", () => {
  assert.doesNotMatch(migration, /create table/i);
  assert.match(migration, /from public\.store_orders so/);
  assert.match(migration, /from public\.store_order_items soi/);
});

// ── Causa raiz corrigida: pedido global nunca e excluido por padrao ─────────

test("listagem NUNCA filtra event_id is not null por padrao -- pedido global so fica de fora se o operador pedir explicitamente", () => {
  const fn = slice(migration, "create or replace function public.list_store_orders_for_admin", "revoke all on function public.list_store_orders_for_admin");
  assert.match(fn, /and \(p_event_id is null or so\.event_id = p_event_id\)/);
  assert.match(fn, /and \(not coalesce\(p_global_only, false\) or so\.event_id is null\)/);
  assert.doesNotMatch(fn, /so\.event_id is not null/);
  assert.match(fn, /coalesce\(e\.name, 'Produto global'\)/);
});

test("detalhe do pedido global (event_id null) tambem funciona -- so pula o lookup de evento quando null, nunca falha", () => {
  const fn = slice(migration, "create or replace function public.get_store_order_admin_detail", "revoke all on function public.get_store_order_admin_detail");
  assert.match(fn, /if v_order\.event_id is not null then\s*\n\s*select \* into v_event from public\.events where id = v_order\.event_id;\s*\n\s*end if;/);
  assert.match(fn, /'event_name', coalesce\(v_event\.name, 'Produto global'\)/);
});

// ── Valores, itens/variantes, status de pagamento e entrega ────────────────

test("listagem calcula item_count e delivery_status agregado (pending/partial/delivered/cancelled/not_applicable) a partir de store_order_items", () => {
  const fn = slice(migration, "create or replace function public.list_store_orders_for_admin", "revoke all on function public.list_store_orders_for_admin");
  assert.match(fn, /count\(\*\) filter \(where soi\.status <> 'cancelled'\) as active_item_count/);
  assert.match(fn, /count\(\*\) filter \(where soi\.status = 'delivered'\) as delivered_count/);
  assert.match(fn, /when i\.delivered_count = i\.active_item_count then 'delivered'/);
  assert.match(fn, /when i\.delivered_count > 0 then 'partial'/);
});

test("detalhe traz produto, imagem principal, variante, quantidade, preco unitario, desconto, subtotal e status de entrega por item", () => {
  const fn = slice(migration, "create or replace function public.get_store_order_admin_detail", "revoke all on function public.get_store_order_admin_detail");
  assert.match(fn, /'name', si\.name,/);
  assert.match(fn, /is_primary limit 1\)/);
  assert.match(fn, /'variant_name', siv\.name,/);
  assert.match(fn, /'unit_price', soi\.unit_price,/);
  assert.match(fn, /'discount_type', soi\.discount_type,\s*\n\s*'discount_value', soi\.discount_value,/);
  assert.match(fn, /'final_amount', soi\.final_amount,/);
  assert.match(fn, /'status', soi\.status,\s*\n\s*'delivered_at', soi\.delivered_at,/);
  assert.match(fn, /'has_qr', \(soi\.qr_token is not null\)/);
});

test("desconto do pedido e a diferenca entre base_amount e final_amount -- nao um campo separado inventado", () => {
  const fn = slice(migration, "create or replace function public.get_store_order_admin_detail", "revoke all on function public.get_store_order_admin_detail");
  assert.match(fn, /'discount_amount', round\(v_order\.base_amount - v_order\.final_amount, 2\)/);
});

test("card da listagem (agora por ITEM, consolidando os dois canais) mostra numero do pedido, comprador, produto/quantidade, evento ou 'Produto global', status de pagamento/entrega e origem", () => {
  assert.match(orderCard, /item\.order_reference/);
  assert.match(orderCard, /item\.buyer/);
  assert.match(orderCard, /Produto global \/ Sem evento/);
  assert.match(orderCard, /item\.quantity/);
  assert.match(orderCard, /item\.product_name/);
  assert.match(orderCard, /<AdminStatusBadge status=\{item\.payment_status\} \/>/);
  assert.match(orderCard, /deliveryStatusLabel\(item\.delivery_status\)/);
  assert.match(orderCard, /SOURCE_LABEL\[item\.source\]/);
});

test("historico do pedido resolve nome do ator a partir de audit_logs.details->>'actor_user_id' -- reaproveita o mesmo padrao ja usado em toda RPC de auditoria do projeto", () => {
  const fn = slice(migration, "create or replace function public.get_store_order_admin_detail", "revoke all on function public.get_store_order_admin_detail");
  assert.match(fn, /left join auth\.users au on au\.id = nullif\(al\.details->>'actor_user_id', ''\)::uuid/);
  assert.match(fn, /entity_type = 'store_orders' and al\.entity_id = p_store_order_id/);
  assert.match(fn, /entity_type = 'store_order_items' and al\.entity_id in/);
});

// ── QR individual ────────────────────────────────────────────────────────

test("detalhe do pedido oferece baixar QR individual do item, reaproveitando a rota ja existente (nao gera QR novo)", () => {
  assert.match(orderDetailActions, /\/api\/loja\/pedidos\/\$\{storeOrderId\}\/itens\/\$\{itemId\}\/qrcode/);
  assert.match(orderDetailActions, /hasQr && \(status === 'confirmed' \|\| status === 'delivered'\)/);
});

// ── Acoes administrativas reaproveitadas (nenhuma RPC nova de mutacao) ──────

test("acoes de confirmar pagamento/cancelar/entregar/desfazer entrega reaproveitam as server actions ja existentes de src/app/loja/actions.ts -- nenhuma RPC de mutacao nova", () => {
  assert.match(orderDetailActions, /from '\.\.\/\.\.\/actions'/);
  assert.match(orderDetailActions, /confirmStoreOrderPaymentAction/);
  assert.match(orderDetailActions, /cancelStoreOrderAction/);
  assert.match(orderDetailActions, /deliverStoreOrderItemAction/);
  assert.match(orderDetailActions, /undoStoreOrderItemDeliveryAction/);
  assert.doesNotMatch(migration, /create or replace function public\.(confirm_store_order_payment|cancel_store_order|deliver_store_order_item|undo_store_order_item_delivery)/);
});

test("acao de cancelar so aparece pra pedido pending, e store.deliver nunca ganha acoes de catalogo/pagamento -- so entrega por item", () => {
  assert.match(orderDetailActions, /if \(status !== 'pending'\) return null;/);
  assert.doesNotMatch(orderDetailActions, /store\.manage/);
  assert.match(lojaActions, /export async function confirmStoreOrderPaymentAction[\s\S]{0,80}await assertPermission\("store\.manage"\);/);
  assert.match(lojaActions, /export async function cancelStoreOrderAction[\s\S]{0,80}await assertPermission\("store\.manage"\);/);
  assert.match(lojaActions, /export async function deliverStoreOrderItemAction[\s\S]{0,80}await assertPermission\("store\.deliver"\);/);
});

// ── Permissoes: backend valida, nao so a UI ─────────────────────────────────

test("RPCs de listagem e detalhe exigem store.view OU store.deliver DENTRO do banco -- store.deliver ve o necessario pra entrega sem virar acesso a catalogo", () => {
  for (const fnName of ["list_store_orders_for_admin", "get_store_order_admin_detail"]) {
    const fn = slice(migration, `create or replace function public.${fnName}`, `revoke all on function public.${fnName}`);
    assert.match(fn, /if not \(public\.current_user_has_permission\('store\.view'\) or public\.current_user_has_permission\('store\.deliver'\)\) then/);
    assert.match(fn, /raise exception 'Sem permissao para visualizar pedidos da loja\.';/);
  }
});

test("pagina de lista e de detalhe exigem store.view OU store.deliver no server antes de renderizar", () => {
  assert.match(ordersListPage, /await requireAnyPermission\(\["store\.view", "store\.deliver"\]\);/);
  assert.match(orderDetailPage, /await requireAnyPermission\(\['store\.view', 'store\.deliver'\]\);/);
});

// ── Cross-organization bloqueado ─────────────────────────────────────────────

test("listagem so retorna pedidos de organizacoes que o ator pode acessar; detalhe rejeita pedido de outra organizacao", () => {
  const listFn = slice(migration, "create or replace function public.list_store_orders_for_admin", "revoke all on function public.list_store_orders_for_admin");
  assert.match(listFn, /where public\.user_can_access_organization\(v_actor, so\.organization_id\)/);
  const detailFn = slice(migration, "create or replace function public.get_store_order_admin_detail", "revoke all on function public.get_store_order_admin_detail");
  assert.match(detailFn, /if not public\.user_can_access_organization\(v_actor, v_order\.organization_id\) then/);
  assert.match(detailFn, /raise exception 'Pedido invalido ou sem acesso\.';/);
});

// ── UX mobile: cards, nao tabela horizontal gigante ─────────────────────────

test("lista e detalhe usam cards responsivos (grid), nunca uma tabela com min-width gigante e scroll horizontal", () => {
  assert.doesNotMatch(ordersListPage, /<table/);
  assert.match(ordersListPage, /grid gap-3 md:grid-cols-2 xl:grid-cols-3/);
  assert.doesNotMatch(orderDetailPage, /<table/);
  assert.doesNotMatch(orderCard, /overflow-x-auto/);
});
