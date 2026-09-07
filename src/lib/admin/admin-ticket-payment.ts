/**
 * Classificacao do filtro de pagamento da listagem admin de ingressos.
 *
 * Identificacao canonica de legado (nao e heuristica de nome/e-mail):
 *   orders.buyer_type = 'imported_holder'
 *   AND orders.import_batch_id IS NOT NULL
 * O CHECK orders_buyer_ownership_check amarra esse par. O lote tambem
 * aparece em import_batch_rows.order_item_id, mas o pedido ja carrega o batch.
 *
 * Ingresso nativo: usa payments.payment_status via orders.payment_id.
 * Ingresso importado materializado: comercialmente PAGO, mesmo sem payment
 * moderno. Cancelamento operacional do ingresso/pedido NAO vira estorno:
 *   Situacao do ingresso = Cancelado (ticket_operational_situation)
 *   Situacao financeira = Pago, salvo payment cancelled/refunded/expired
 * Filtro Situacao: Ativos exclui o cancelado. Pagamento: Pago + Situacao:
 * Todos continua encontrando esse ingresso.
 *
 * Nao grava payment ficticio. A funcao SQL ticket_admin_payment_class
 * deve permanecer identica.
 */

export const ADMIN_TICKET_PAYMENT_CLASSES = ['pago', 'pendente', 'cancelado'] as const;
export type AdminTicketPaymentClass = (typeof ADMIN_TICKET_PAYMENT_CLASSES)[number];

export type AdminTicketPaymentInput = {
  buyerType?: string | null;
  importBatchId?: string | null;
  ticketStatus?: string | null;
  orderStatus?: string | null;
  paymentStatus?: string | null;
};

function norm(value: string | null | undefined) {
  return String(value ?? '').trim().toLowerCase();
}

export function isLegacyImportedOrder(input: Pick<AdminTicketPaymentInput, 'buyerType' | 'importBatchId'>) {
  return norm(input.buyerType) === 'imported_holder' && Boolean(input.importBatchId);
}

export function classifyAdminTicketPayment(input: AdminTicketPaymentInput): AdminTicketPaymentClass | null {
  const payment = norm(input.paymentStatus);
  const paymentRefunded = payment === 'cancelled' || payment === 'refunded' || payment === 'expired';

  if (isLegacyImportedOrder(input)) {
    if (paymentRefunded) return 'cancelado';
    return 'pago';
  }

  if (payment === 'paid') return 'pago';
  if (payment === 'pending') return 'pendente';
  if (paymentRefunded) return 'cancelado';
  return null;
}

export function matchesAdminTicketPaymentFilter(
  input: AdminTicketPaymentInput,
  filter: AdminTicketPaymentClass | '' | null | undefined,
) {
  if (!filter) return true;
  return classifyAdminTicketPayment(input) === filter;
}

export function isActivePaidAdminTicket(
  input: AdminTicketPaymentInput & { situacao?: string | null },
) {
  return norm(input.situacao) === 'ativos' && classifyAdminTicketPayment(input) === 'pago';
}

export function adminTicketPaymentStatusForList(input: AdminTicketPaymentInput) {
  const classified = classifyAdminTicketPayment(input);
  const payment = norm(input.paymentStatus);
  if (classified === 'pago') return 'paid';
  if (classified === 'pendente') return payment || 'pending';
  if (classified === 'cancelado') return payment || 'cancelled';
  return payment || null;
}
