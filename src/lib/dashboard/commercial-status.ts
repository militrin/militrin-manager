/**
 * Fonte única de verdade pra status comercial de negócio (Confirmado/
 * Pendente/Expirado/Cancelado) e pra apresentação de comprador/destinatário.
 * Usado pelo Dashboard (cards + drill-down) e deve ser reaproveitado por
 * qualquer relatório futuro que precise da mesma classificação -- nunca
 * reimplementar isto localmente em outro arquivo.
 *
 * AUDITORIA QUE FUNDAMENTA ISTO (não é suposição -- lida em produção,
 * somente leitura, e no código-fonte das RPCs reais):
 *
 * - order_items.status aceita 'reserved'|'confirmed'|'cancelled'|'expired'|
 *   'refunded'|'transferred' (CHECK constraint), mas na prática NUNCA chega a
 *   'expired': a única rotina que expira reservas,
 *   public.release_expired_reservations() (supabase/migrations/
 *   20260815001914_remote_schema.sql:9653), só atualiza
 *   payments.payment_status='expired' e participants.{registration_status=
 *   'cancelled', reservation_status='expired'} -- nunca toca orders.status
 *   nem order_items.status, que ficam parados em 'pending'/'reserved' pra
 *   sempre. Confirmado com 2 pedidos reais expirados em produção (MIL-2026-
 *   00001068 e 00001069): payments.payment_status='expired',
 *   orders.status='pending', order_items.status='reserved' -- todos os 3
 *   ainda com o valor pré-expiração.
 * - Por isso o Dashboard não pode confiar só em order_items.status: precisa
 *   cruzar com payments.payment_status (sinal mais confiável, é o que a
 *   rotina de expiração realmente atualiza) e, na ausência de qualquer sinal
 *   explícito, DERIVAR do prazo (order_items.reservation_expires_at) --
 *   esse campo nunca é limpo pela rotina de expiração, então continua
 *   disponível como "quando expirou" mesmo depois.
 * - order_items_status_check/orders_status_check/payments_status_check
 *   (mesmo arquivo, linhas 14885/14912/14955) confirmam os valores válidos.
 */

export type CommercialStatus = "confirmed" | "pending" | "expired" | "cancelled";

export const COMMERCIAL_STATUS_LABELS: Record<CommercialStatus, string> = {
  confirmed: "Confirmado",
  pending: "Pendente",
  expired: "Expirado",
  cancelled: "Cancelado",
};

const CANCELLED_VALUES = new Set(["cancelled", "canceled", "void", "voided"]);
// Estorno tecnicamente não é "cancelado" nem tem card próprio pedido -- dobra
// no balde Cancelado pro Dashboard de 4 categorias, documentado aqui (não é
// perda de informação: o status bruto original continua disponível pra quem
// precisar do detalhe fino).
const REFUNDED_VALUES = new Set(["refunded"]);
const CONFIRMED_VALUES = new Set(["confirmed", "paid"]);
const EXPIRED_VALUES = new Set(["expired"]);

export type CommercialStatusInput = {
  itemStatus?: string | null;
  orderStatus?: string | null;
  paymentStatus?: string | null;
  /** order_items.reservation_expires_at -- usado só quando nenhuma das 3 colunas acima já diz "expired" explicitamente. */
  reservationExpiresAt?: string | null;
  now?: Date;
};

/**
 * Resolve o status de NEGÓCIO (o que o Dashboard mostra) a partir dos status
 * técnicos brutos. Ordem de prioridade: cancelado/estornado > confirmado >
 * expirado (explícito OU derivado do prazo) > pendente (default).
 */
export function resolveCommercialStatus(input: CommercialStatusInput): CommercialStatus {
  const item = String(input.itemStatus ?? "").toLowerCase();
  const order = String(input.orderStatus ?? "").toLowerCase();
  const payment = String(input.paymentStatus ?? "").toLowerCase();

  if (CANCELLED_VALUES.has(item) || CANCELLED_VALUES.has(order) || REFUNDED_VALUES.has(item) || REFUNDED_VALUES.has(order) || REFUNDED_VALUES.has(payment)) {
    return "cancelled";
  }
  if (CONFIRMED_VALUES.has(item) || CONFIRMED_VALUES.has(order) || payment === "paid") {
    return "confirmed";
  }
  if (EXPIRED_VALUES.has(item) || EXPIRED_VALUES.has(order) || EXPIRED_VALUES.has(payment)) {
    return "expired";
  }
  if (input.reservationExpiresAt) {
    const expiresAt = new Date(input.reservationExpiresAt);
    const now = input.now ?? new Date();
    if (!Number.isNaN(expiresAt.getTime()) && expiresAt <= now) return "expired";
  }
  return "pending";
}

export function commercialStatusFriendlyReason(status: CommercialStatus, hasPaymentAttempt: boolean): string | undefined {
  if (status === "expired") {
    return hasPaymentAttempt
      ? "Pagamento não realizado dentro do prazo."
      : "Prazo de pagamento expirou antes de qualquer tentativa de pagamento.";
  }
  return undefined;
}

// ── Comprador / destinatário de cortesia ────────────────────────────────────
// orders.buyer_type distingue 'account' (comprador real, orders.user_id
// preenchido) de 'administrative' (emissão manual/cortesia, user_id SEMPRE
// null por design -- ver CHECK orders_buyer_ownership_check) e
// 'imported_holder' (importação em lote). Nunca inventar um comprador quando
// user_id é null; em vez disso, mostrar quem RECEBEU o ingresso (holder) com
// um rótulo que deixa claro que não é uma compra comercial.
export type BuyerPresentation = {
  label: string; // "Comprador" ou "Destinatário"
  name: string; // nome resolvido, nunca "Comprador não identificado" quando já sabemos pra quem foi
  isCourtesy: boolean;
};

export function resolveBuyerPresentation(input: {
  buyerType?: string | null;
  buyerName?: string | null; // nome já resolvido via orders.user_id (customer_profiles/get_operation_buyers)
  holderName?: string | null; // titular/destinatário do ingresso (order_items.holder_full_name ou participants.full_name)
  paymentMethod?: string | null; // 'courtesy' quando aplicável
}): BuyerPresentation {
  const isAdministrative = input.buyerType === "administrative" || input.buyerType === "imported_holder";
  const isCourtesyPayment = input.paymentMethod === "courtesy";
  const isCourtesy = isAdministrative || isCourtesyPayment;

  if (input.buyerName) {
    return { label: "Comprador", name: isCourtesy ? `${input.buyerName} (Cortesia)` : input.buyerName, isCourtesy };
  }
  if (isCourtesy && input.holderName) {
    return { label: "Destinatário", name: `${input.holderName} (Cortesia)`, isCourtesy: true };
  }
  return { label: "Comprador", name: "Comprador não identificado", isCourtesy };
}
