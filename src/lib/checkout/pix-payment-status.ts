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
 * 'expired' de verdade, quem renderiza este estado NAO deve mais oferecer
 * "gerar novo pagamento" -- ver `canRegeneratePix`.
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
 * Regenerar PIX so e seguro quando o pedido AINDA esta 'pending' no banco --
 * regenerar sobre um pedido ja marcado 'expired'/'cancelled' de verdade nao e
 * uma operacao coberta pela regra atual de start_order_payment_pix (ver nota
 * na migration 20260902000000_simulate_fake_gateway_payment_paid.sql).
 */
export function canRegeneratePix(paymentStatus: string | null | undefined): boolean {
  return normalizePaymentStatus(paymentStatus) === "pending";
}

export function formatPixCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
