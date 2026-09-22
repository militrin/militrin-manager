export class GatewayChargeUnpersistedError extends Error {
  readonly code = "GATEWAY_CHARGE_UNPERSISTED";
  readonly providerPaymentId: string;
  readonly cancelled: boolean;

  constructor(message: string, providerPaymentId: string, cancelled: boolean) {
    super(message);
    this.name = "GatewayChargeUnpersistedError";
    this.providerPaymentId = providerPaymentId;
    this.cancelled = cancelled;
  }
}

export function isGatewayChargeUnpersistedError(error: unknown): error is GatewayChargeUnpersistedError {
  if (error instanceof GatewayChargeUnpersistedError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; providerPaymentId?: unknown };
  return candidate.code === "GATEWAY_CHARGE_UNPERSISTED" && typeof candidate.providerPaymentId === "string";
}
