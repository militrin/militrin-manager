import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  additionalItemIdentity,
  additionalItemStatus,
  additionalItemStatusLabel,
  checkoutProductBelongsToCadastro,
  checkoutProductQrHref,
  mergeAdditionalItems,
  storeProductQrHref,
} from "../src/lib/operations/additional-product-items.ts";

const MICHELI_BUYER = "82b43f55-a494-469a-91f9-dd9037a3b4bf";
const MICHELI_CONTACT = "40b5065f-b45f-4715-86c6-d5245344508d";
const ORDER_2123 = "bd398c2d-1846-4e79-a5c0-63be863a988c";
const COPO_ITEM = "bc15c895-6670-4f59-8b9c-6ff3920713b1";
const HOLDER_B_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("compre junto pertence ao Cadastro da conta compradora, nao ao titular B", () => {
  assert.equal(
    checkoutProductBelongsToCadastro({ cadastroUserId: MICHELI_BUYER, orderUserId: MICHELI_BUYER }),
    true,
  );
  assert.equal(
    checkoutProductBelongsToCadastro({ cadastroUserId: HOLDER_B_USER, orderUserId: MICHELI_BUYER }),
    false,
  );
  assert.equal(
    checkoutProductBelongsToCadastro({ cadastroUserId: null, orderUserId: MICHELI_BUYER }),
    false,
  );
  assert.equal(
    checkoutProductBelongsToCadastro({ cadastroUserId: MICHELI_BUYER, orderUserId: null }),
    false,
  );
});

test("Micheli #002123: copo pago nao entregue vira Pendente de entrega com QR canonico", () => {
  const status = additionalItemStatus({
    itemStatus: "confirmed",
    deliveredAt: null,
    orderStatus: "confirmed",
    paymentStatus: "paid",
  });
  assert.equal(status, "confirmed");
  assert.equal(additionalItemStatusLabel(status), "Pendente de entrega");
  assert.equal(
    checkoutProductQrHref({
      orderId: ORDER_2123,
      itemId: COPO_ITEM,
      hasQrToken: true,
      pickupQrMode: "per_line",
      status,
    }),
    `/api/inscricao/pedidos/${ORDER_2123}/itens/${COPO_ITEM}/qrcode`,
  );
});

test("entregue usa delivered_at e nao oferece QR de modo none", () => {
  const status = additionalItemStatus({
    itemStatus: "confirmed",
    deliveredAt: "2026-09-30T12:00:00.000Z",
  });
  assert.equal(status, "delivered");
  assert.equal(additionalItemStatusLabel(status), "Entregue");
  assert.equal(
    checkoutProductQrHref({
      orderId: ORDER_2123,
      itemId: COPO_ITEM,
      hasQrToken: true,
      pickupQrMode: "none",
      status: "confirmed",
    }),
    null,
  );
});

test("identidade canonica nao mistura loja e compre junto nem deduplica por nome", () => {
  const merged = mergeAdditionalItems([
    { source: "store", id: "store-1", name: "Copo" },
    { source: "checkout", id: COPO_ITEM, name: "Copo" },
    { source: "checkout", id: COPO_ITEM, name: "Copo duplicado" },
    { source: "store", id: "store-1", name: "Copo de novo" },
  ]);
  assert.deepEqual(merged.map((item) => additionalItemIdentity(item.source, item.id)), [
    "store:store-1",
    `checkout:${COPO_ITEM}`,
  ]);
});

test("pedido multi-titular: produto do checkout nao aparece no Cadastro de B", () => {
  const order = { user_id: MICHELI_BUYER, items: [{ kind: "ticket", holderUserId: MICHELI_BUYER }, { kind: "ticket", holderUserId: HOLDER_B_USER }, { kind: "product", id: COPO_ITEM }] };
  const cadastroA = { id: MICHELI_CONTACT, user_id: MICHELI_BUYER };
  const cadastroB = { id: "contact-b", user_id: HOLDER_B_USER };
  const products = order.items.filter((item) => item.kind === "product");
  const visibleA = products.filter(() => checkoutProductBelongsToCadastro({
    cadastroUserId: cadastroA.user_id,
    orderUserId: order.user_id,
  }));
  const visibleB = products.filter(() => checkoutProductBelongsToCadastro({
    cadastroUserId: cadastroB.user_id,
    orderUserId: order.user_id,
  }));
  assert.equal(visibleA.length, 1);
  assert.equal(visibleB.length, 0);
});

test("QR da loja e do compre junto usam rotas de dominios diferentes", () => {
  assert.equal(
    storeProductQrHref({ orderId: "store-order", itemId: "store-item", status: "confirmed" }),
    "/api/loja/pedidos/store-order/itens/store-item/qrcode",
  );
  assert.doesNotMatch(
    checkoutProductQrHref({
      orderId: ORDER_2123,
      itemId: COPO_ITEM,
      hasQrToken: true,
      status: "confirmed",
    }) ?? "",
    /\/api\/loja\//,
  );
});

const [cadastroPage, details, actions, types] = await Promise.all([
  readFile(new URL("../src/app/cadastros/[id]/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/app/operacoes/components/ExpandedTicketDetails.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/app/operacoes/actions.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/app/operacoes/types.ts", import.meta.url), "utf8"),
]);

test("Cadastro une loja solo e compre junto pela conta compradora, sem writer", () => {
  assert.match(cadastroPage, /checkoutProductBelongsToCadastro/);
  assert.match(cadastroPage, /\.from\("order_items"\)/);
  assert.match(cadastroPage, /item_kind/);
  assert.match(cadastroPage, /eq\("orders\.user_id", contactUserId\)/);
  assert.match(cadastroPage, /source: "checkout"/);
  assert.match(cadastroPage, /source: "store"/);
  assert.match(cadastroPage, /mergeAdditionalItems/);
  assert.doesNotMatch(cadastroPage, /add_product_to_cart_order|admin_grant_store_item_to_contact\(/);
  assert.match(cadastroPage, /additionalItemStatusLabel/);
  assert.match(cadastroPage, /Ver QR/);
  assert.match(cadastroPage, /hasPermission\("store\.deliver"\)/);
  assert.doesNotMatch(cadastroPage, /in\("id", ticketOrderIds\)[\s\S]{0,200}item_kind/);
});

test("Central une store_order_items com order_items.product sem cap 250 e sem writer de leitura", () => {
  assert.match(actions, /checkoutProductBelongsToCadastro/);
  assert.match(actions, /item_kind/);
  assert.match(actions, /source: "checkout"/);
  assert.match(types, /source: "store" \| "checkout"/);
  assert.match(actions, /list_operation_ticket_page/);
  assert.doesNotMatch(actions, /\.range\(0,\s*249\)/);
  const detailsFn = actions.slice(actions.indexOf("async function buildTicketDetails"), actions.indexOf("export async function getOperationTicketDetailsAction"));
  assert.doesNotMatch(detailsFn, /add_product_to_cart_order|reserve_store_item_stock|deliver_store_order_item|deliver_order_item_product/);
  assert.match(details, /item\.source === "checkout"/);
  assert.match(details, /onDeliverAdditionalItem\(\{ id: item\.id, source: item\.source \}\)/);
});

test("RBAC: leitura nao entrega; Entregar continua exigindo store.deliver", () => {
  assert.match(details, /item.status === "confirmed" && capabilities.canDeliverStoreItems/);
  assert.match(actions, /export async function deliverAdditionalStoreItemAction[\s\S]{0,80}await assertPermission\("store\.deliver"\)/);
  assert.match(actions, /export async function deliverOrderItemProductAction[\s\S]{0,80}await assertPermission\("store\.deliver"\)/);
  const page = cadastroPage;
  assert.match(page, /canViewProductQr/);
  assert.match(page, /item.qrHref && canViewProductQr/);
});
