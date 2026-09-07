import { normalizePaymentStatus } from './pix-payment-status.ts';

export const CARD_CHECKOUT_ATTEMPTED_PREFIX = 'militrin:card-checkout-attempted:';

const redirectInFlightOrders = new Set<string>();

export type CardCheckoutPendingPhase = 'redirecting' | 'pending_retry';

export type CardCheckoutRedirectDecisionInput = {
  paymentStatus?: string | null;
  lastGatewayAttemptStatus?: string | null;
  isFakePaymentProvider: boolean;
  hasOpenedHostedCheckout: boolean;
  redirectInFlight: boolean;
  autoRedirectFailed?: boolean;
};

export function cardCheckoutAttemptedStorageKey(orderId: string): string {
  return `${CARD_CHECKOUT_ATTEMPTED_PREFIX}${orderId}`;
}

export function isCardCheckoutRedirectInFlight(orderId: string): boolean {
  return redirectInFlightOrders.has(orderId);
}

/** Reserva o pedido para um unico redirect em voo (Strict Mode, double click, refresh rapido). */
export function beginCardCheckoutRedirect(orderId: string): boolean {
  const id = String(orderId ?? '').trim();
  if (!id) return false;
  if (redirectInFlightOrders.has(id)) return false;
  redirectInFlightOrders.add(id);
  return true;
}

export function endCardCheckoutRedirect(orderId: string): void {
  const id = String(orderId ?? '').trim();
  if (!id) return;
  redirectInFlightOrders.delete(id);
}

/** Apenas testes: zera o lock em memoria entre casos. */
export function resetCardCheckoutRedirectLocksForTests(): void {
  redirectInFlightOrders.clear();
}

export function hasCardCheckoutBeenAttempted(
  orderId: string,
  storage?: Pick<Storage, 'getItem'> | null,
): boolean {
  const id = String(orderId ?? '').trim();
  if (!id) return false;
  const store = storage ?? (typeof window === 'undefined' ? null : window.sessionStorage);
  if (!store) return false;
  try {
    return store.getItem(cardCheckoutAttemptedStorageKey(id)) === '1';
  } catch {
    return false;
  }
}

export function markCardCheckoutAttempted(
  orderId: string,
  storage?: Pick<Storage, 'setItem'> | null,
): void {
  const id = String(orderId ?? '').trim();
  if (!id) return;
  const store = storage ?? (typeof window === 'undefined' ? null : window.sessionStorage);
  if (!store) return;
  try {
    store.setItem(cardCheckoutAttemptedStorageKey(id), '1');
  } catch {
    // sessionStorage pode estar indisponivel (iframe, modo privado). O lease
    // do servidor continua impedindo cobranca duplicada.
  }
}

/**
 * Primeira tentativa: ainda nao abrimos o checkout hospedado, pagamento
 * pending, sem recusa. Nao redireciona se ja pago/cancelado/expirado/recusado
 * nem no provider fake (fica na pagina para simular).
 */
export function shouldAutoRedirectToHostedCardCheckout(
  input: CardCheckoutRedirectDecisionInput,
): boolean {
  if (input.isFakePaymentProvider) return false;
  if (input.hasOpenedHostedCheckout) return false;
  if (input.redirectInFlight) return false;
  if (input.autoRedirectFailed) return false;
  const status = normalizePaymentStatus(input.paymentStatus);
  if (status !== 'pending') return false;
  if (String(input.lastGatewayAttemptStatus ?? '').trim().toLowerCase() === 'refused') return false;
  return true;
}

/** CTA de retry: pending (inclusive recusa) ou expirado; nunca pago/cancelado. */
export function shouldOfferCardCheckoutRetry(input: {
  paymentStatus?: string | null;
}): boolean {
  const status = normalizePaymentStatus(input.paymentStatus);
  return status === 'pending' || status === 'expired';
}

export function shouldShowCardRedirectingPhase(input: {
  isFakePaymentProvider: boolean;
  isRedirecting: boolean;
  hasOpenedHostedCheckout: boolean;
  autoRedirectFailed?: boolean;
  paymentStatus?: string | null;
  lastGatewayAttemptStatus?: string | null;
}): CardCheckoutPendingPhase {
  if (input.isFakePaymentProvider) return 'pending_retry';
  const status = normalizePaymentStatus(input.paymentStatus);
  if (status !== 'pending') return 'pending_retry';
  if (String(input.lastGatewayAttemptStatus ?? '').trim().toLowerCase() === 'refused') {
    return 'pending_retry';
  }
  if (input.isRedirecting) return 'redirecting';
  if (input.autoRedirectFailed) return 'pending_retry';
  if (input.hasOpenedHostedCheckout) return 'pending_retry';
  return 'redirecting';
}
