import type { AsaasEnvironment } from "@/lib/payments/asaas-provider";
import { AsaasPaymentProvider } from "@/lib/payments/asaas-provider";
import { FakeGatewayProvider } from "@/lib/payments/fake-gateway-provider";
import type { PaymentGatewayProvider, PaymentProviderName } from "@/lib/payments/provider";
export { canUseCurrentGatewayForCharge, getPaymentGatewayAccountKey } from "@/lib/payments/gateway-account-key";

/**
 * Selecao do provider canonico do checkout (`PAYMENT_PROVIDER=asaas|fake`).
 * Independente da selecao legada `MILITRIN_PAYMENT_PROVIDER`.
 *
 * Credenciais sao globais via env server-side (nunca NEXT_PUBLIC_). Trocar a
 * conta Asaas e trocar as env vars, sem alterar codigo. `ASAAS_ACCOUNT_KEY`
 * e um rotulo opaco gravado em `payments.gateway_account_key` para saber
 * qual configuracao criou a cobranca -- nunca e a API key.
 *
 * `organizationId` ainda nao resolve credencial por organizacao.
 */
export function getPaymentGatewayProviderName(): PaymentProviderName {
  const raw = String(process.env.PAYMENT_PROVIDER ?? "fake").trim().toLowerCase();
  return raw === "asaas" ? "asaas" : "fake";
}

export function getPaymentGatewayProvider(
  providerName: PaymentProviderName = getPaymentGatewayProviderName(),
  _organizationId?: string
): PaymentGatewayProvider {
  void _organizationId;

  if (providerName === "asaas") {
    const apiKey = String(process.env.ASAAS_API_KEY ?? "").trim();
    const webhookToken = String(process.env.ASAAS_WEBHOOK_TOKEN ?? "").trim();
    const previousWebhookToken = String(process.env.ASAAS_WEBHOOK_TOKEN_PREVIOUS ?? "").trim() || null;
    const environment = (String(process.env.ASAAS_ENVIRONMENT ?? "sandbox").trim().toLowerCase() === "production"
      ? "production"
      : "sandbox") satisfies AsaasEnvironment;

    if (!apiKey || !webhookToken) {
      throw new Error(
        "PAYMENT_PROVIDER=asaas requer ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN configuradas (server-side, nunca NEXT_PUBLIC_)."
      );
    }

    return new AsaasPaymentProvider({ apiKey, webhookToken, previousWebhookToken, environment });
  }

  return new FakeGatewayProvider({ webhookToken: process.env.ASAAS_WEBHOOK_TOKEN ?? null });
}

/** Resolve o provider pelo nome persistido em `payments.provider`, para reconciliacao/cancelamento tardio. */
export function getPaymentGatewayProviderByName(providerName: string, organizationId?: string): PaymentGatewayProvider {
  const normalized = providerName === "asaas" ? "asaas" : "fake";
  return getPaymentGatewayProvider(normalized, organizationId);
}
