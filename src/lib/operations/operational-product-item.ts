// Formato canonico consumido pela CAMADA OPERACIONAL (Loja -> Pedidos,
// Central de Operacoes, Modo Turbo) pra produto vendido em qualquer um dos
// dois canais -- loja standalone (store_orders/store_order_items) ou
// "compre junto" no checkout de ingresso (orders/order_items,
// item_kind='product'). As tabelas continuam separadas (nenhuma migrada,
// nenhuma copiada) -- isto e SOMENTE a forma normalizada que a UI/acoes
// consomem, alimentada por list_operational_product_items (Loja -> Pedidos)
// e pelos resolvers de QR em src/app/operacoes/actions.ts (Turbo/Central).
// `source`+`item_id`+`order_id` sao SEMPRE preservados crus, exatamente pra
// que a acao de entrega (deliverOperationalProductItemAction) saiba em qual
// dominio atuar -- nunca inferido.
export type OperationalProductItem = {
  source: "store" | "checkout";
  item_id: string;
  order_id: string;
  order_reference: string;
  product_name: string;
  variant: string | null;
  quantity: number;
  event_id: string | null;
  event_name: string;
  buyer: string;
  /** Status do PEDIDO (pending/confirmed/cancelled/expired/refunded) -- pagamento, nao entrega. */
  payment_status: string;
  /** not_applicable = pedido ainda nao confirmado (pagamento pendente). */
  delivery_status: "not_applicable" | "to_deliver" | "delivered" | "cancelled";
  delivered_at: string | null;
  /** Nome do operador que realizou a PRIMEIRA entrega -- null enquanto delivery_status != 'delivered'. */
  delivered_by: string | null;
};

export const SOURCE_LABEL: Record<OperationalProductItem["source"], string> = {
  store: "Loja",
  checkout: "Compra junto ao ingresso",
};

export function deliveryStatusLabel(status: OperationalProductItem["delivery_status"]) {
  switch (status) {
    case "delivered":
      return { label: "Entregue", className: "border-cyan-500/40 bg-cyan-500/15 text-cyan-200" };
    case "to_deliver":
      return { label: "A entregar", className: "border-amber-500/40 bg-amber-500/15 text-amber-200" };
    case "cancelled":
      return { label: "Cancelado", className: "border-rose-500/40 bg-rose-500/15 text-rose-200" };
    default:
      return { label: "Pagamento pendente", className: "border-slate-600 bg-slate-800/70 text-slate-200" };
  }
}
