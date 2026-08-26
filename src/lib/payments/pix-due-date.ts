const PIX_TIMEZONE = "America/Sao_Paulo";

/**
 * Data de vencimento (YYYY-MM-DD) para uma cobranca PIX criada agora, sempre
 * no fuso do Brasil -- independente de onde o processo roda (servidor,
 * CI, etc). O prazo real que o comprador enxerga e o de
 * `order_items.reservation_expires_at`/`payments.expires_at` (tipicamente
 * ~2h, ja existente); `dueDate` e so o campo de vencimento exigido pela API
 * da Asaas para criar a cobranca.
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
