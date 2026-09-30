import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  additionalItemStatus,
  additionalItemStatusLabel,
  canDeliverProductLine,
  checkoutProductPickupPageHref,
  checkoutProductQrHref,
  storeProductPickupPageHref,
  storeProductQrHref,
} from "../src/lib/operations/additional-product-items.ts";
import {
  buildProductPickupPassData,
  formatOperationalQrPreview,
  productPickupOrderLabel,
  PRODUCT_PICKUP_PASS_COPY,
} from "../src/lib/product-pickup/product-pickup-pass.ts";
import { pathRequiresAuth } from "../src/lib/auth/middleware-guard.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const ORDER_2123 = "bd398c2d-1846-4e79-a5c0-63be863a988c";
const COPO_ITEM = "bc15c895-6670-4f59-8b9c-6ff3920713b1";
const STORE_ORDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ITEM = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("copy operacional de produto e Aguardando retirada / Entregue", () => {
  assert.equal(additionalItemStatusLabel("confirmed"), "Aguardando retirada");
  assert.equal(additionalItemStatusLabel("delivered"), "Entregue");
  assert.equal(PRODUCT_PICKUP_PASS_COPY.pending, "Aguardando retirada");
  assert.equal(PRODUCT_PICKUP_PASS_COPY.delivered, "Entregue");
  assert.doesNotMatch(PRODUCT_PICKUP_PASS_COPY.pending, /Pendente de entrega|Retirada pendente/);
});

test("pedido #002123 e codigo ITEM-* aparecem no comprovante sem UUID/CPF", () => {
  assert.equal(productPickupOrderLabel(2123, "MIL-2026-00002123"), "#002123");
  assert.equal(formatOperationalQrPreview("ITEM-3F01FA4D1B65"), "ITEM-3F01…");
  assert.equal(formatOperationalQrPreview("UNIT-ABCD1234EF56"), "UNIT-ABCD…");
  const pass = buildProductPickupPassData({
    productName: "Copo Térmico Logo",
    quantity: 1,
    displayNumber: 2123,
    orderNumber: "MIL-2026-00002123",
    itemStatus: "confirmed",
    qrs: [{ unitLabel: null, qrDataUrl: "data:image/png;base64,xx", qrPreview: "ITEM-3F01…", alt: "QR" }],
  });
  assert.equal(pass.orderLabel, "#002123");
  assert.equal(pass.quantityLabel, "1 unidade");
  assert.equal(pass.statusLabel, "Aguardando retirada");
  assert.equal(pass.instruction, PRODUCT_PICKUP_PASS_COPY.instructionPending);
});

test("comprovante entregue mantem QR consultavel e deixa de ser pendente", () => {
  const pass = buildProductPickupPassData({
    productName: "Copo Térmico Logo",
    quantity: 1,
    displayNumber: 2123,
    itemStatus: "delivered",
    deliveredAt: "2026-09-30T12:00:00.000Z",
    qrs: [{ unitLabel: null, qrDataUrl: "data:image/png;base64,xx", qrPreview: "ITEM-3F01…", alt: "QR" }],
  });
  assert.equal(pass.status, "delivered");
  assert.equal(pass.statusLabel, "Entregue");
  assert.equal(pass.instruction, PRODUCT_PICKUP_PASS_COPY.instructionDelivered);
  assert.ok(pass.deliveredAtLabel);
  assert.equal(pass.qrs.length, 1);
});

test("CTA Ver QR aponta para pagina, SVG da API permanece como gerador", () => {
  const status = additionalItemStatus({ itemStatus: "confirmed", deliveredAt: null, orderStatus: "confirmed" });
  assert.equal(
    checkoutProductQrHref({ orderId: ORDER_2123, itemId: COPO_ITEM, hasQrToken: true, status }),
    `/api/inscricao/pedidos/${ORDER_2123}/itens/${COPO_ITEM}/qrcode`,
  );
  assert.equal(
    checkoutProductPickupPageHref({ orderId: ORDER_2123, itemId: COPO_ITEM, hasQrToken: true, status }),
    `/produto/retirada/checkout/${ORDER_2123}/${COPO_ITEM}`,
  );
  assert.equal(
    storeProductQrHref({ orderId: STORE_ORDER, itemId: STORE_ITEM, status: "confirmed" }),
    `/api/loja/pedidos/${STORE_ORDER}/itens/${STORE_ITEM}/qrcode`,
  );
  assert.equal(
    storeProductPickupPageHref({ orderId: STORE_ORDER, itemId: STORE_ITEM, status: "confirmed" }),
    `/produto/retirada/loja/${STORE_ORDER}/${STORE_ITEM}`,
  );
});

test("per_unit com quantity>1 abre pagina e nao o SVG da linha", () => {
  const status = "confirmed";
  assert.equal(
    checkoutProductQrHref({ orderId: ORDER_2123, itemId: COPO_ITEM, hasQrToken: true, pickupQrMode: "per_unit", status, quantity: 2 }),
    null,
  );
  assert.equal(
    checkoutProductPickupPageHref({ orderId: ORDER_2123, itemId: COPO_ITEM, hasQrToken: true, pickupQrMode: "per_unit", status, quantity: 2 }),
    `/produto/retirada/checkout/${ORDER_2123}/${COPO_ITEM}`,
  );
});

test("entrega de linha so para confirmed per_line", () => {
  assert.equal(canDeliverProductLine({ status: "confirmed", pickupQrMode: "per_line" }), true);
  assert.equal(canDeliverProductLine({ status: "delivered", pickupQrMode: "per_line" }), false);
  assert.equal(canDeliverProductLine({ status: "confirmed", pickupQrMode: "per_unit" }), false);
  assert.equal(canDeliverProductLine({ status: "confirmed", pickupQrMode: "none" }), false);
});

test("pagina de comprovante e mobile-first, sem chrome admin e sem CTA de entrega", async () => {
  const page = await read("src/app/produto/retirada/[source]/[orderId]/[itemId]/page.tsx");
  const layout = await read("src/app/produto/retirada/layout.tsx");
  const pass = await read("src/components/product-pickup/ProductPickupPass.tsx");
  assert.match(page, /ProductPickupPass/);
  assert.match(page, /generateQrDataUrl/);
  assert.match(page, /item_kind', 'product'/);
  assert.match(page, /store_order_items/);
  assert.doesNotMatch(page, /DeliverProductButton|Marcar como entregue|deliverOperationalProductItemAction/);
  assert.doesNotMatch(page, /cpf|telefone|email|Sidebar/);
  assert.doesNotMatch(layout, /Sidebar|requireAnyPermission/);
  assert.match(pass, /RETIRADA DE PRODUTO|PRODUCT_PICKUP_PASS_COPY\.title/);
  assert.match(pass, /max-w-\[320px\]/);
  assert.match(pass, /bg-white/);
  assert.doesNotMatch(pass, /MilitrinTicketCard|Acesso Militrin|ingresso/i);
  assert.ok(pathRequiresAuth(`/produto/retirada/checkout/${ORDER_2123}/${COPO_ITEM}`));
});

test("Pedido, Cadastro, Central e Minha Conta usam a pagina; SVG cru sai do CTA", async () => {
  const [pedido, cadastro, central, account, wizard, loja] = await Promise.all([
    read("src/app/inscricoes/pedido/[orderId]/page.tsx"),
    read("src/app/cadastros/[id]/page.tsx"),
    read("src/app/operacoes/components/ExpandedTicketDetails.tsx"),
    read("src/app/minha-conta/compras/[orderId]/page.tsx"),
    read("src/app/inscricao/[eventSlug]/wizard.tsx"),
    read("src/app/loja/pedidos/[orderId]/order-detail-actions.tsx"),
  ]);
  assert.match(pedido, /OrderProductItemCard/);
  assert.match(pedido, /checkoutProductPickupPageHref/);
  assert.match(pedido, /hasPermission\("store\.deliver"\)/);
  assert.match(cadastro, /item.pickupHref && canViewProductQr/);
  assert.match(cadastro, /DeliverProductButton/);
  assert.doesNotMatch(cadastro, /qrHref\?inline=1|\$\{item\.qrHref\}\?inline=1/);
  assert.match(central, /item.qr_page_href/);
  assert.match(central, /DeliverProductConfirmDialog/);
  assert.doesNotMatch(central, /qr_href\}\?inline=1/);
  assert.match(account, /produto\/retirada\/checkout/);
  assert.doesNotMatch(account, /Marcar como entregue|DeliverProductButton/);
  assert.match(wizard, /produto\/retirada\/checkout/);
  assert.doesNotMatch(wizard, /qrcode\?inline=1/);
  assert.match(loja, /produto\/retirada\/loja/);
  assert.match(loja, /deliverStoreOrderItemAction/);
  assert.match(loja, /DeliverProductConfirmDialog/);
});

test("writers canonicos permanecem separados e dialog nao chama no cancelar", async () => {
  const [dialog, dispatcher, checkoutWriter, storeWriter, sql] = await Promise.all([
    read("src/components/product-pickup/DeliverProductConfirmDialog.tsx"),
    read("src/app/operacoes/actions.ts"),
    read("src/app/inscricoes/pedido/[orderId]/order-product-item-card.tsx"),
    read("src/app/loja/pedidos/[orderId]/order-detail-actions.tsx"),
    read("supabase/migrations/20260932000000_product_pickup_delivery_and_undo.sql"),
  ]);
  assert.match(dialog, /Cancelar/);
  assert.match(dialog, /onCancel/);
  assert.match(dispatcher, /if \(item.source === "store"\) return deliverAdditionalStoreItemAction/);
  assert.match(dispatcher, /if \(item.source === "checkout"\) return deliverOrderItemProductAction/);
  assert.match(checkoutWriter, /source="checkout"/);
  assert.match(storeWriter, /deliverStoreOrderItemAction\(itemId\)/);
  assert.doesNotMatch(dispatcher, /create or replace function public\.deliver_/);
  assert.match(sql, /if v_item.status = 'delivered' then return true;/);
  assert.match(sql, /if v_line.status = 'delivered' then return true;/);
  const checkoutFn = sql.slice(sql.indexOf("deliver_order_item_product(p_order_item_id uuid)"), sql.indexOf("deliver_store_order_item(p_store_order_item_id uuid)"));
  assert.ok(checkoutFn.indexOf("if v_item.status = 'delivered' then return true;") < checkoutFn.indexOf("perform public.deliver_store_item_stock"));
});

test("rotas SVG e UNIT-* continuam existindo", async () => {
  const [checkoutSvg, storeSvg, checkoutUnit, storeUnit] = await Promise.all([
    read("src/app/api/inscricao/pedidos/[orderId]/itens/[itemId]/qrcode/route.ts"),
    read("src/app/api/loja/pedidos/[storeOrderId]/itens/[itemId]/qrcode/route.ts"),
    read("src/app/api/inscricao/pedidos/[orderId]/itens/[itemId]/qrcode/unidades/[unitId]/route.ts"),
    read("src/app/api/loja/pedidos/[storeOrderId]/itens/[itemId]/qrcode/unidades/[unitId]/route.ts"),
  ]);
  assert.match(checkoutSvg, /image\/svg\+xml/);
  assert.match(storeSvg, /image\/svg\+xml/);
  assert.match(checkoutUnit, /order_item_pickup_units/);
  assert.match(storeUnit, /store_order_item_pickup_units/);
});
