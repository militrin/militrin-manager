export type CheckoutIntentItem = {
  pricing_gender?: string | null;
  shirt_type?: string | null;
  shirt_size?: string | null;
  ownership_mode?: string | null;
};

function compact(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Chave estável da intenção comercial de checkout. Sem timestamp.
 * Mesmo usuário, evento, categoria, quantidade, método, cupom e itens
 * resolvem o mesmo pedido pending recuperável.
 */
export function buildCheckoutIntentKey(input: {
  eventId: string;
  categoryId?: string | null;
  cpf: string;
  quantity: number;
  paymentMethod: string;
  couponCode?: string | null;
  items: CheckoutIntentItem[];
}): string {
  const items = input.items
    .map((item) =>
      [
        compact(item.pricing_gender),
        compact(item.shirt_type),
        compact(item.shirt_size),
        compact(item.ownership_mode),
      ].join("/"),
    )
    .join("|");
  return [
    "checkout-intent:v1",
    String(input.eventId ?? "").trim(),
    String(input.categoryId ?? "").trim() || "single",
    String(input.cpf ?? "").replace(/\D/g, ""),
    String(Math.max(1, Math.trunc(Number(input.quantity) || 1))),
    compact(input.paymentMethod),
    compact(input.couponCode),
    items,
  ].join(":");
}
