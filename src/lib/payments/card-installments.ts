/** Teto real do gateway Asaas no fluxo atual (POST /payments + installmentCount). */
export const GATEWAY_MAX_CARD_INSTALLMENTS = 12;

/** Default seguro: preserva o checkout atual (opcoes 1x + 2..12). */
export const DEFAULT_MAX_CARD_INSTALLMENTS = GATEWAY_MAX_CARD_INSTALLMENTS;

export function normalizeMaxCardInstallments(value: unknown): number {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return DEFAULT_MAX_CARD_INSTALLMENTS;
  return Math.min(GATEWAY_MAX_CARD_INSTALLMENTS, Math.max(1, parsed));
}

export function cardInstallmentsLimitMessage(allowed: unknown): string {
  return `Este evento permite pagamento em até ${normalizeMaxCardInstallments(allowed)}x.`;
}

/**
 * Fonte de verdade da regra de limite. Nunca reduz silenciosamente:
 * devolve a mensagem de rejeicao, ou null se a quantidade e permitida.
 */
export function rejectCardInstallmentsIfOverLimit(requested: unknown, allowed: unknown): string | null {
  const requestedCount = Math.max(1, Math.floor(Number(requested) || 1));
  const allowedCount = normalizeMaxCardInstallments(allowed);
  if (requestedCount > allowedCount) return cardInstallmentsLimitMessage(allowedCount);
  return null;
}

export function eventOffersCardInstallments(installmentsEnabled: boolean, maxCardInstallments: unknown): boolean {
  return Boolean(installmentsEnabled) && normalizeMaxCardInstallments(maxCardInstallments) >= 2;
}

/** Restaura/ajusta a selecao de UI (2..max). Nao substitui a rejeicao no backend. */
export function clampUiCardInstallments(requested: unknown, maxCardInstallments: unknown): number {
  const max = normalizeMaxCardInstallments(maxCardInstallments);
  const parsed = Math.floor(Number(requested) || 2);
  if (max < 2) return 2;
  return Math.min(max, Math.max(2, parsed));
}

export function cardInstallmentChoices(maxCardInstallments: unknown = GATEWAY_MAX_CARD_INSTALLMENTS): number[] {
  const max = normalizeMaxCardInstallments(maxCardInstallments);
  return Array.from({ length: max }, (_, index) => index + 1);
}

export function filterInstallmentOptions<T extends { installments: number }>(
  options: T[],
  maxCardInstallments: unknown,
): T[] {
  const max = normalizeMaxCardInstallments(maxCardInstallments);
  return options.filter((option) => option.installments >= 2 && option.installments <= max);
}
