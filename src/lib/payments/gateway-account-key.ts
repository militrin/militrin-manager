import {
  getPaymentGatewayAccountKeyForMethod,
  isConfiguredGatewayAccountKey,
} from "./asaas-account-registry.ts";

/**
 * Rotulo logico da conta Asaas usada para NOVAS cobrancas PIX.
 * Fallback Gate #1: ASAAS_PIX_ACCOUNT_KEY || ASAAS_ACCOUNT_KEY.
 * Identificador curto -- nunca a API key.
 */
export function getPaymentGatewayAccountKey(): string | null {
  return getPaymentGatewayAccountKeyForMethod("pix");
}

/**
 * Opera na API somente quando o rotulo persistido ainda esta no registry
 * (PIX, cartao ou trio legado). Sem rotulo ou rotulo desconhecido: nao
 * chamar outra conta com o id da cobranca antiga.
 */
export function canUseCurrentGatewayForCharge(storedAccountKey: string | null | undefined): boolean {
  const stored = String(storedAccountKey ?? "").trim();
  if (!stored) return false;
  return isConfiguredGatewayAccountKey(stored);
}
