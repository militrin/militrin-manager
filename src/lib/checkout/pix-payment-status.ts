// Logica pura de apresentacao do bloco de pagamento PIX (sem React/JSX) --
// extraida para ser testavel isoladamente e reutilizada por
// src/app/inscricao/[eventSlug]/pix-payment-card.tsx. Nunca decide nada
// sobre preco, reserva, titularidade ou emissao de ticket -- so traduz um
// status cru de payments.payment_status (+ o contador de tempo ja calculado
// pelo chamador) para um estado de apresentacao.

export type PixPaymentDisplayStatus = "pending" | "paid" | "expired" | "cancelled" | "error";

/** Traduz o status cru gravado no banco -- nunca expor a string tecnica na tela. */
export function normalizePaymentStatus(status: string | null | undefined): PixPaymentDisplayStatus {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "paid") return "paid";
  if (normalized === "expired") return "expired";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  if (normalized === "pending" || normalized === "processing") return "pending";
  return "error";
}

/**
 * Estado final exibido na tela. O contador local pode chegar a zero bem
 * antes de qualquer rotina de expiracao no banco rodar (nao ha cron
 * automatico -- ver expire_stale_order_payments). Enquanto o banco ainda
 * disser 'pending', tratamos a chegada a zero como expiracao "leve": para de
 * mostrar o QR como pagavel, mas ainda e seguro oferecer gerar um PIX novo
 * (o pedido continua tecnicamente pendente). Uma vez que o banco confirme
 * 'expired' de verdade, ainda e permitido gerar um PIX novo quando o
 * pedido nao foi cancelado -- ver `canRegeneratePix`. A cobranca antiga no
 * gateway pode continuar existindo; o sistema local usa `expires_at`.
 */
export function resolvePixDisplayStatus(
  paymentStatus: string | null | undefined,
  countdownSeconds: number | null,
): PixPaymentDisplayStatus {
  const dbStatus = normalizePaymentStatus(paymentStatus);
  const softExpired = dbStatus === "pending" && countdownSeconds !== null && countdownSeconds <= 0;
  return softExpired ? "expired" : dbStatus;
}

/**
 * Regenerar PIX e seguro enquanto o pagamento ainda nao foi confirmado nem
 * cancelado -- inclusive apos expiracao local. `start_order_payment_pix`
 * reabre itens expirados para reserved e persiste uma cobranca nova (a
 * antiga e cancelada best-effort no gateway da mesma conta).
 */
export function canRegeneratePix(paymentStatus: string | null | undefined): boolean {
  const status = normalizePaymentStatus(paymentStatus);
  return status === "pending" || status === "expired";
}

/** Reutiliza a cobranca atual so se ainda estiver pending, com PIX e prazo futuro. */
export function isReusableLivePix(payment: {
  payment_status?: string | null;
  pix_code?: string | null;
  expires_at?: string | null;
  now?: Date;
}): boolean {
  if (normalizePaymentStatus(payment.payment_status) !== "pending") return false;
  if (!String(payment.pix_code ?? "").trim()) return false;
  if (!payment.expires_at) return false;
  const expiresAt = new Date(payment.expires_at).getTime();
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt > (payment.now ?? new Date()).getTime();
}

export function formatPixCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
