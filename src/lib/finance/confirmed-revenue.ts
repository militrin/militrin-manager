import { shouldIncludeAmountInFinancialTotals } from '../imports/legacy-price.ts';
import {
  resolveGatewayEnvironment,
  type GatewayEnvironmentSource,
} from '../payments/gateway-environment.ts';

export type ConfirmedRevenuePayment = GatewayEnvironmentSource & {
  payment_status?: string | null;
  payment_method?: string | null;
  price_origin?: string | null;
  provider?: string | null;
  gateway_payment_id?: string | null;
  final_amount?: number | null;
};

export function isSyntheticGatewayPayment(payment: ConfirmedRevenuePayment) {
  const provider = String(payment.provider ?? '').trim().toLowerCase();
  const gatewayId = String(payment.gateway_payment_id ?? '').trim().toLowerCase();
  return provider === 'fake' || gatewayId.startsWith('fake_');
}

export function isLiveGatewayPayment(payment: ConfirmedRevenuePayment) {
  return resolveGatewayEnvironment(payment) === 'production';
}

export function isSandboxGatewayPayment(payment: ConfirmedRevenuePayment) {
  return resolveGatewayEnvironment(payment) === 'sandbox';
}

function isOperationalCandidate(payment: ConfirmedRevenuePayment) {
  if (String(payment.payment_method ?? '') === 'courtesy') return false;
  if (!shouldIncludeAmountInFinancialTotals(payment.price_origin)) return false;
  if (isSyntheticGatewayPayment(payment)) return false;
  if (!isLiveGatewayPayment(payment)) return false;
  return true;
}

/**
 * Receita confirmada operacional = pagamentos LIVE, paid/confirmed,
 * sem legacy_unknown, fake, cortesia, cancelled/expired ou refunded.
 * SANDBOX nunca entra. Ticket cancelado sem refund nao retira LIVE paid.
 */
export function shouldIncludeInConfirmedRevenue(payment: ConfirmedRevenuePayment) {
  if (String(payment.payment_status ?? '') !== 'paid') return false;
  return isOperationalCandidate(payment);
}

/**
 * Receita estornada operacional = LIVE efetivamente refunded.
 * SANDBOX refunded nao entra na metrica financeira real.
 */
export function shouldIncludeInRefundedRevenue(payment: ConfirmedRevenuePayment) {
  if (String(payment.payment_status ?? '') !== 'refunded') return false;
  return isOperationalCandidate(payment);
}

export function shouldIncludeInPendingRevenue(payment: ConfirmedRevenuePayment) {
  if (String(payment.payment_status ?? '') !== 'pending') return false;
  return isOperationalCandidate(payment);
}

export function confirmedRevenueAmount(payment: ConfirmedRevenuePayment) {
  if (!shouldIncludeInConfirmedRevenue(payment)) return 0;
  return Number(payment.final_amount ?? 0);
}

export function refundedRevenueAmount(payment: ConfirmedRevenuePayment) {
  if (!shouldIncludeInRefundedRevenue(payment)) return 0;
  return Number(payment.final_amount ?? 0);
}

export function pendingRevenueAmount(payment: ConfirmedRevenuePayment) {
  if (!shouldIncludeInPendingRevenue(payment)) return 0;
  return Number(payment.final_amount ?? 0);
}

export function confirmedRevenueExclusionReason(payment: ConfirmedRevenuePayment) {
  const status = String(payment.payment_status ?? '');
  if (status === 'refunded') {
    if (isSandboxGatewayPayment(payment)) return 'SANDBOX estornado: fora da receita operacional';
    if (!isLiveGatewayPayment(payment)) return 'Estorno sem ambiente LIVE: fora da receita operacional';
    return 'Estorno LIVE: sai da receita confirmada e entra na receita estornada';
  }
  if (status === 'cancelled' || status === 'canceled') return 'Pagamento cancelado';
  if (status === 'expired') return 'Pagamento expirado';
  if (status !== 'paid') return 'Pagamento nao confirmado';
  if (String(payment.payment_method ?? '') === 'courtesy') return 'Cortesia: nao e receita financeira';
  if (!shouldIncludeAmountInFinancialTotals(payment.price_origin)) return 'Preço histórico não informado';
  if (isSyntheticGatewayPayment(payment)) return 'Pagamento sintético isolado da receita confirmada';
  if (isSandboxGatewayPayment(payment)) return 'SANDBOX: fora da receita operacional LIVE';
  if (!isLiveGatewayPayment(payment)) return 'Sem ambiente LIVE demonstrável: fora da receita operacional';
  return null;
}
