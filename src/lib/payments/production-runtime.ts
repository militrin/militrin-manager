/**
 * Runtime em que e proibido gerar PIX/cartao fake ou cair em mock silencioso.
 * Vercel Production e NODE_ENV=production (exceto preview/dev da Vercel).
 */
export function isProductionPaymentRuntime(): boolean {
  const vercelEnv = String(process.env.VERCEL_ENV ?? "").trim().toLowerCase();
  if (vercelEnv === "production") return true;
  if (vercelEnv === "preview" || vercelEnv === "development") return false;
  return String(process.env.NODE_ENV ?? "").trim() === "production";
}

export const STORE_PAYMENT_UNAVAILABLE_MESSAGE = "Pagamento indisponível no momento.";
