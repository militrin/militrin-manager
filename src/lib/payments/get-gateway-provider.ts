import { AsaasPaymentProvider } from "@/lib/payments/asaas-provider";
import {
  GatewayAccountNotConfiguredError,
  getAsaasAccountCredentialsForAccountKey,
  getAsaasAccountCredentialsForMethod,
  type AsaasCheckoutMethod,
} from "@/lib/payments/asaas-account-registry";
import { FakeGatewayProvider } from "@/lib/payments/fake-gateway-provider";
import type { PaymentGatewayProvider, PaymentProviderName } from "@/lib/payments/provider";
export { canUseCurrentGatewayForCharge, getPaymentGatewayAccountKey } from "@/lib/payments/gateway-account-key";
export { getPaymentGatewayAccountKeyForMethod } from "@/lib/payments/asaas-account-registry";

/**
 * Selecao do provider canonico do checkout (`PAYMENT_PROVIDER=asaas|fake`).
 * Independente da selecao legada `MILITRIN_PAYMENT_PROVIDER`.
 *
 * Credenciais Asaas sao resolvidas por metodo (PIX vs cartao) e por
 * `payments.gateway_account_key` historico. Nunca ha uma unica API key
 * global obrigatoria quando os trios `ASAAS_PIX_*` / `ASAAS_CARD_*`
 * existem. O trio legado `ASAAS_API_KEY` / `ASAAS_ACCOUNT_KEY` /
 * `ASAAS_WEBHOOK_TOKEN` permanece como fallback Gate #1.
 *
 * `organizationId` ainda nao resolve credencial por organizacao.
 */
export function getPaymentGatewayProviderName(): PaymentProviderName {
  const raw = String(process.env.PAYMENT_PROVIDER ?? "fake").trim().toLowerCase();
  return raw === "asaas" ? "asaas" : "fake";
}

function asaasProviderFromCredentials(accountKey: string): PaymentGatewayProvider {
  const credentials = getAsaasAccountCredentialsForAccountKey(accountKey);
  if (!credentials) {
    throw new GatewayAccountNotConfiguredError(accountKey);
  }
  return new AsaasPaymentProvider({
    apiKey: credentials.apiKey,
    webhookToken: credentials.webhookToken,
    environment: credentials.environment,
    accountKey: credentials.accountKey,
    previousWebhookToken: null,
  });
}

export function getPaymentGatewayProviderForMethod(method: AsaasCheckoutMethod): PaymentGatewayProvider {
  if (getPaymentGatewayProviderName() !== "asaas") {
    return new FakeGatewayProvider({ webhookToken: process.env.ASAAS_WEBHOOK_TOKEN ?? null });
  }

  const credentials = getAsaasAccountCredentialsForMethod(method);
  if (!credentials) {
    const required =
      method === "pix"
        ? "ASAAS_PIX_API_KEY, ASAAS_PIX_ACCOUNT_KEY e ASAAS_PIX_WEBHOOK_TOKEN (ou o trio legado ASAAS_API_KEY / ASAAS_ACCOUNT_KEY / ASAAS_WEBHOOK_TOKEN)"
        : "ASAAS_CARD_API_KEY, ASAAS_CARD_ACCOUNT_KEY e ASAAS_CARD_WEBHOOK_TOKEN (ou o trio legado ASAAS_API_KEY / ASAAS_ACCOUNT_KEY / ASAAS_WEBHOOK_TOKEN)";
    throw new Error(`PAYMENT_PROVIDER=asaas requer ${required} para o metodo ${method}.`);
  }

  return asaasProviderFromCredentials(credentials.accountKey);
}

/**
 * Resolve o provider da cobranca historica pelo rotulo persistido.
 * Nunca cai na "conta ativa de hoje" se o rotulo nao estiver no registry.
 */
export function getPaymentGatewayProviderForAccountKey(accountKey: string | null | undefined): PaymentGatewayProvider {
  const stored = String(accountKey ?? "").trim();
  if (!stored) {
    throw new GatewayAccountNotConfiguredError("");
  }
  return asaasProviderFromCredentials(stored);
}

export function tryGetPaymentGatewayProviderForAccountKey(
  accountKey: string | null | undefined,
): PaymentGatewayProvider | null {
  try {
    return getPaymentGatewayProviderForAccountKey(accountKey);
  } catch {
    return null;
  }
}

/** Novas cobrancas PIX (Gate #1). Cartao deve usar `getPaymentGatewayProviderForMethod('credit_card')`. */
export function getPaymentGatewayProvider(
  providerName: PaymentProviderName = getPaymentGatewayProviderName(),
  _organizationId?: string,
): PaymentGatewayProvider {
  void _organizationId;
  if (providerName === "asaas") {
    return getPaymentGatewayProviderForMethod("pix");
  }
  return new FakeGatewayProvider({ webhookToken: process.env.ASAAS_WEBHOOK_TOKEN ?? null });
}

/**
 * Resolve o provider pelo nome persistido em `payments.provider`.
 * Operacoes Asaas de cobranca existente exigem `gateway_account_key`.
 */
export function getPaymentGatewayProviderByName(
  providerName: string,
  organizationId?: string,
  accountKey?: string | null,
): PaymentGatewayProvider {
  void organizationId;
  if (providerName === "asaas") {
    if (accountKey && String(accountKey).trim()) {
      return getPaymentGatewayProviderForAccountKey(accountKey);
    }
    throw new GatewayAccountNotConfiguredError(String(accountKey ?? ""));
  }
  return getPaymentGatewayProvider("fake");
}
