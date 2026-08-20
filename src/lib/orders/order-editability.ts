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
};

export function isOrderStillEditable({ orderStatus, paymentStatus, paymentExpiresAt }: OrderEditabilityInput): boolean {
  if (orderStatus !== "pending") return false;
  if (paymentStatus !== "pending") return false;
  if (paymentExpiresAt && new Date(paymentExpiresAt).getTime() <= Date.now()) return false;
  return true;
}
