/**
 * Valor canônico da cobrança no gateway: `payments.final_amount`.
 * Já inclui a taxa de pagamento quando o evento a repassa ao comprador
 * (ex.: produto R$ 215, cobrança PIX R$ 216,99). Nunca usar o subtotal
 * do pedido para liquidar.
 */
export function roundGatewayAmount(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return Number.NaN;
  return Math.round(amount * 100) / 100;
}

export function expectedGatewayAmountFromPayment(payment: {
  final_amount?: number | null;
  amount?: number | null;
}): number {
  return roundGatewayAmount(payment.final_amount ?? payment.amount ?? 0);
}

export function gatewayAmountMatchesExpected(expected: number, gateway: number): boolean {
  const left = roundGatewayAmount(expected);
  const right = roundGatewayAmount(gateway);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return left === right;
}

export function parseAsaasGatewayAmount(value: unknown): number | null {
  if (value == null || value === "") return null;
  const amount = roundGatewayAmount(value);
  return Number.isFinite(amount) ? amount : null;
}

export function assertPositiveGatewayAmount(amount: unknown, context: string): number {
  const parsed = roundGatewayAmount(amount);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${context}: valor da cobranca deve ser maior que zero.`);
  }
  return parsed;
}
