const PIX_TIMEZONE = "America/Sao_Paulo";

/**
 * Detector de legado: o Asaas devolve `pixQrCode.expirationDate` ~1 ano.
 * Nao e a regra comercial. So identifica expires_at que nao e o dueDate.
 */
const PIX_QR_ARTIFACT_MS = 30 * 24 * 60 * 60 * 1000;

function saoPauloDateParts(instant: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PIX_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return { year, month, day };
}

/**
 * Data de vencimento (YYYY-MM-DD) enviada ao Asaas ao criar a cobranca.
 * Fonte primaria do prazo comercial: fim desse dia em America/Sao_Paulo.
 */
export function todayAsPixDueDate(now = new Date()): string {
  const { year, month, day } = saoPauloDateParts(now);
  return `${year}-${month}-${day}`;
}

/** Fim do dia comercial do PIX (23:59:59 em America/Sao_Paulo). */
export function pixDueDateEndOfDay(dueDate: string): string {
  return `${dueDate}T23:59:59-03:00`;
}

export function earlierIsoTimestamp(...values: Array<string | null | undefined>): string | null {
  const times = values
    .map((value) => {
      if (!value) return null;
      const time = new Date(value).getTime();
      return Number.isFinite(time) ? { value, time } : null;
    })
    .filter((row): row is { value: string; time: number } => Boolean(row));
  if (times.length === 0) return null;
  return times.reduce((earliest, row) => (row.time < earliest.time ? row : earliest)).value;
}

function impliedDueDateFromCreatedAt(createdAt: Date): string | null {
  const { year, month, day } = saoPauloDateParts(createdAt);
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

/**
 * Prazo comercial da reserva PIX.
 *
 * 1. Fonte primaria: `payments.expires_at` depois da gravacao correta
 *    (min(QR expirationDate, dueDate 23:59:59-03) na criacao da cobranca).
 * 2. Fallback legado: se o valor persistido e o expirationDate longo do QR
 *    (expires_at >= created_at + 30 dias), deriva o dueDate como o dia
 *    civil de `created_at` em America/Sao_Paulo — o mesmo `todayAsPixDueDate()`
 *    enviado ao Asaas na criacao — e usa o fim desse dia.
 * 3. Sem dueDate e sem created_at utilizavel: devolve o expires_at persistido.
 *    Cartao e demais metodos nunca entram no fallback.
 */
export function resolvePixCommercialExpiresAt(input: {
  expiresAt?: string | null;
  paymentCreatedAt?: string | null;
  paymentMethod?: string | null;
  dueDate?: string | null;
}): string | null {
  const stored = String(input.expiresAt ?? "").trim() || null;
  const method = String(input.paymentMethod ?? "").trim().toLowerCase();
  if (method !== "pix") return stored;
  if (!stored) return stored;

  const explicitDueDate = String(input.dueDate ?? "").trim() || null;
  if (explicitDueDate && /^\d{4}-\d{2}-\d{2}$/.test(explicitDueDate)) {
    return earlierIsoTimestamp(stored, pixDueDateEndOfDay(explicitDueDate)) ?? stored;
  }

  const created = input.paymentCreatedAt ? new Date(input.paymentCreatedAt) : null;
  const storedDate = new Date(stored);
  if (!created || Number.isNaN(created.getTime()) || Number.isNaN(storedDate.getTime())) return stored;
  if (storedDate.getTime() - created.getTime() < PIX_QR_ARTIFACT_MS) return stored;
  const impliedDueDate = impliedDueDateFromCreatedAt(created);
  if (!impliedDueDate) return stored;
  return pixDueDateEndOfDay(impliedDueDate);
}

/** True se ainda ha prazo comercial para PIX/cartao persistido. Sem expires_at, nao inventa vencimento. */
export function isCommercialPaymentWindowOpen(
  input: {
    expiresAt?: string | null;
    paymentCreatedAt?: string | null;
    paymentMethod?: string | null;
    dueDate?: string | null;
    now?: Date;
  },
): boolean {
  const expiresAt = resolvePixCommercialExpiresAt(input);
  if (!expiresAt) return true;
  const time = new Date(expiresAt).getTime();
  if (!Number.isFinite(time)) return false;
  return time > (input.now ?? new Date()).getTime();
}
