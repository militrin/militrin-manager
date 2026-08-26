import type { AsaasEnvironment } from "@/lib/payments/asaas-provider";
import { AsaasPaymentProvider } from "@/lib/payments/asaas-provider";
import { FakeGatewayProvider } from "@/lib/payments/fake-gateway-provider";
import type { PaymentGatewayProvider, PaymentProviderName } from "@/lib/payments/provider";

/**
 * Selecao do provider canonico (Fase 1 Asaas). Independente da selecao
 * legada `MILITRIN_PAYMENT_PROVIDER` (src/lib/payments/get-provider.ts), que
 * continua servindo o checkout publico atual sem nenhuma alteracao.
 *
 * `organizationId` e recebido mas ainda nao usado para resolver credenciais
 * por organizacao -- nesta fase (MVP de organizacao unica) a credencial e
 * global via variavel de ambiente server-side. O parametro existe para que a
 * Fase 2 (credencial por organizacao) nao exija mudar a assinatura desta
 * funcao em nenhum call site.
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
    const environment = (String(process.env.ASAAS_ENVIRONMENT ?? "sandbox").trim().toLowerCase() === "production"
      ? "production"
      : "sandbox") satisfies AsaasEnvironment;

    if (!apiKey || !webhookToken) {
      throw new Error(
        "PAYMENT_PROVIDER=asaas requer ASAAS_API_KEY e ASAAS_WEBHOOK_TOKEN configuradas (server-side, nunca NEXT_PUBLIC_)."
      );
    }

    return new AsaasPaymentProvider({ apiKey, webhookToken, environment });
  }

  return new FakeGatewayProvider({ webhookToken: process.env.ASAAS_WEBHOOK_TOKEN ?? null });
}

/** Resolve o provider pelo nome persistido em `payments.provider`, para reconciliacao/cancelamento tardio. */
export function getPaymentGatewayProviderByName(providerName: string, organizationId?: string): PaymentGatewayProvider {
  const normalized = providerName === "asaas" ? "asaas" : "fake";
  return getPaymentGatewayProvider(normalized, organizationId);
}
