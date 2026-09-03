const PIX_TIMEZONE = "America/Sao_Paulo";

/**
 * Data de vencimento (YYYY-MM-DD) exigida pela API Asaas ao criar a cobranca.
 * O prazo que o comprador ve e `payments.expires_at`, persistido a partir de
 * `pixQrCode.expirationDate` (nao um timeout local arbitrario).
 */
export function todayAsPixDueDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PIX_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}
