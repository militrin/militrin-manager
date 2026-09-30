/**
 * Leitura administrativa unificada dos dois domínios de produto adicional.
 *
 * Loja solo: store_orders / store_order_items (já vinculada ao Cadastro).
 * Compre junto: orders / order_items.item_kind='product'.
 *
 * Atribuição do compre junto: o produto pertence à CONTA COMPRADORA
 * (orders.user_id === registration_contacts.user_id). Nunca ao titular de
 * outro ingresso do mesmo pedido, nunca por nome/CPF/primeiro ticket.
 *
 * Identidade canônica por linha física:
 *   store:${store_order_item.id}
 *   checkout:${order_item.id}
 */

export type AdditionalItemSource = "store" | "checkout";

export type AdditionalItemStatus = "reserved" | "confirmed" | "delivered" | "cancelled";

const CANCELLED_ITEM_STATUSES = new Set(["cancelled", "expired", "refunded", "transferred"]);
const PAID_PAYMENT_STATUSES = new Set(["paid", "confirmed", "received", "succeeded"]);

export function additionalItemIdentity(source: AdditionalItemSource, id: string) {
  return `${source}:${id}`;
}

export function checkoutProductBelongsToCadastro(input: {
  cadastroId?: string | null;
  cadastroUserId: string | null | undefined;
  orderUserId: string | null | undefined;
  itemRegistrationContactId?: string | null;
}) {
  const cadastroId = String(input.cadastroId ?? "").trim();
  const itemContactId = String(input.itemRegistrationContactId ?? "").trim();
  if (itemContactId) return Boolean(cadastroId) && cadastroId === itemContactId;
  const cadastroUserId = String(input.cadastroUserId ?? "").trim();
  const orderUserId = String(input.orderUserId ?? "").trim();
  return Boolean(cadastroUserId && orderUserId && cadastroUserId === orderUserId);
}

export function additionalItemStatus(input: {
  itemStatus: string | null | undefined;
  deliveredAt: string | null | undefined;
  orderStatus?: string | null;
  paymentStatus?: string | null;
}): AdditionalItemStatus {
  const itemStatus = String(input.itemStatus ?? "").trim().toLowerCase();
  const orderStatus = String(input.orderStatus ?? "").trim().toLowerCase();
  if (CANCELLED_ITEM_STATUSES.has(itemStatus) || CANCELLED_ITEM_STATUSES.has(orderStatus)) {
    return "cancelled";
  }
  if (input.deliveredAt || itemStatus === "delivered") return "delivered";
  const paymentStatus = String(input.paymentStatus ?? "").trim().toLowerCase();
  if (
    itemStatus === "confirmed"
    || orderStatus === "confirmed"
    || PAID_PAYMENT_STATUSES.has(paymentStatus)
  ) {
    return "confirmed";
  }
  return "reserved";
}

export function additionalItemStatusLabel(status: AdditionalItemStatus) {
  if (status === "delivered") return "Entregue";
  if (status === "confirmed") return "Aguardando retirada";
  if (status === "cancelled") return "Cancelado";
  return "Aguardando pagamento";
}

export function canDeliverProductLine(input: {
  status: AdditionalItemStatus;
  pickupQrMode?: string | null;
}) {
  if (input.status !== "confirmed") return false;
  const mode = String(input.pickupQrMode ?? "per_line").trim().toLowerCase() || "per_line";
  return mode !== "per_unit" && mode !== "none";
}

function pickupPageAllowed(input: {
  hasQrToken: boolean;
  pickupQrMode?: string | null;
  status: AdditionalItemStatus;
  quantity?: number;
}) {
  if (input.status === "cancelled") return false;
  if (input.pickupQrMode === "none") return false;
  if (input.pickupQrMode === "per_unit" && Number(input.quantity ?? 1) > 1) return true;
  return Boolean(input.hasQrToken);
}

export function productPickupPageHref(input: {
  source: AdditionalItemSource;
  orderId: string;
  itemId: string;
  hasQrToken: boolean;
  pickupQrMode?: string | null;
  status: AdditionalItemStatus;
  quantity?: number;
}) {
  if (!input.orderId || !input.itemId) return null;
  if (!pickupPageAllowed(input)) return null;
  const sourcePath = input.source === "store" ? "loja" : "checkout";
  return `/produto/retirada/${sourcePath}/${input.orderId}/${input.itemId}`;
}

export function checkoutProductPickupPageHref(input: {
  orderId: string;
  itemId: string;
  hasQrToken: boolean;
  pickupQrMode?: string | null;
  status: AdditionalItemStatus;
  quantity?: number;
}) {
  return productPickupPageHref({ ...input, source: "checkout" });
}

export function storeProductPickupPageHref(input: {
  orderId: string;
  itemId: string;
  hasQrToken?: boolean;
  pickupQrMode?: string | null;
  status: AdditionalItemStatus;
  quantity?: number;
}) {
  return productPickupPageHref({
    source: "store",
    orderId: input.orderId,
    itemId: input.itemId,
    hasQrToken: input.hasQrToken !== false,
    pickupQrMode: input.pickupQrMode,
    status: input.status,
    quantity: input.quantity,
  });
}

export function mergeAdditionalItems<T extends { source: AdditionalItemSource; id: string }>(items: T[]) {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const item of items) {
    const key = additionalItemIdentity(item.source, item.id);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export function checkoutProductQrHref(input: {
  orderId: string;
  itemId: string;
  hasQrToken: boolean;
  pickupQrMode?: string | null;
  status: AdditionalItemStatus;
  quantity?: number;
}) {
  if (!input.hasQrToken || input.status === "cancelled") return null;
  if (input.pickupQrMode === "none") return null;
  if (input.pickupQrMode === "per_unit" && Number(input.quantity ?? 1) > 1) return null;
  return `/api/inscricao/pedidos/${input.orderId}/itens/${input.itemId}/qrcode`;
}

export function storeProductQrHref(input: {
  orderId: string;
  itemId: string;
  hasQrToken?: boolean;
  pickupQrMode?: string | null;
  status: AdditionalItemStatus;
  quantity?: number;
}) {
  if (input.hasQrToken === false || input.status === "cancelled") return null;
  if (input.pickupQrMode === "none") return null;
  if (input.pickupQrMode === "per_unit" && Number(input.quantity ?? 1) > 1) return null;
  return `/api/loja/pedidos/${input.orderId}/itens/${input.itemId}/qrcode`;
}
