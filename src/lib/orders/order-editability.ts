import { resolvePixCommercialExpiresAt } from "../payments/pix-due-date.ts";

/**
 * Regra unica de "este pedido ainda pode ser tratado como carrinho atual" --
 * usada tanto pelo wizard (hidratacao de journey/edicao via ?editOrder=) quanto
 * pela pagina de detalhe do pedido (mostrar ou nao "Editar pedido"). O backend
 * continua a autoridade real (toda RPC de carrinho ja rejeita mutacao fora de
 * orders.status='pending'); esta funcao so decide o que a UI oferece.
 */
export type OrderEditabilityInput = {
  orderStatus: string | null | undefined;
  paymentStatus: string | null | undefined;
  paymentExpiresAt: string | null | undefined;
  paymentCreatedAt?: string | null;
  paymentMethod?: string | null;
};

export function isOrderStillEditable({
  orderStatus,
  paymentStatus,
  paymentExpiresAt,
  paymentCreatedAt,
  paymentMethod,
}: OrderEditabilityInput): boolean {
  if (orderStatus !== "pending") return false;
  if (paymentStatus !== "pending") return false;
  const commercialExpiresAt = resolvePixCommercialExpiresAt({
    expiresAt: paymentExpiresAt,
    paymentCreatedAt,
    paymentMethod,
  });
  if (commercialExpiresAt && new Date(commercialExpiresAt).getTime() <= Date.now()) return false;
  return true;
}
