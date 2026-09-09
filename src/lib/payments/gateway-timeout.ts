export const ASAAS_REFUND_TIMEOUT_MS = 15_000;

export class GatewayTimeoutError extends Error {
  constructor(message = "Timeout ao chamar o gateway de pagamento.") {
    super(message);
    this.name = "GatewayTimeoutError";
  }
}

export function isGatewayTimeoutError(error: unknown): error is GatewayTimeoutError {
  if (error instanceof GatewayTimeoutError) return true;
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name) : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "AbortError" || name === "GatewayTimeoutError" || /timeout|aborted/i.test(message);
}
