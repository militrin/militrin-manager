/**
 * Ambiente da cobranca no gateway.
 * `production` e o valor persistido (arquitetura atual); a UI mostra LIVE.
 * Nao detectar por nome de pessoa, e-mail, valor, ticket cancelado ou prefixo
 * arbitrario de cobranca.
 */

export type GatewayEnvironment = "sandbox" | "production";

/**
 * Contas Asaas ja persistidas em `payments.gateway_account_key`.
 * O rotulo e o identificador tecnico da conta configurada, nao heuristica.
 */
export const GATEWAY_ACCOUNT_ENVIRONMENT: Record<string, GatewayEnvironment> = {
  "asaas-conta-live-01": "production",
  "asaas-sandbox-militrin": "sandbox",
};

export type GatewayEnvironmentSource = {
  gateway_environment?: string | null;
  gateway_account_key?: string | null;
  provider?: string | null;
  gateway_payment_id?: string | null;
};

export function isGatewayEnvironment(value: string | null | undefined): value is GatewayEnvironment {
  return value === "sandbox" || value === "production";
}

/**
 * Prefixo oficial do access token Asaas (`$aact_hmlg_` / `$aact_prod_`).
 * Fonte tecnica da credencial usada, nao do ASAAS_ENVIRONMENT sozinho.
 */
export function detectAsaasAccessTokenEnvironment(apiKey: string | null | undefined): GatewayEnvironment | null {
  const token = String(apiKey ?? "").trim().replace(/^\\/, "");
  if (token.startsWith("$aact_hmlg_")) return "sandbox";
  if (token.startsWith("$aact_prod_")) return "production";
  return null;
}

export function resolveGatewayEnvironment(payment: GatewayEnvironmentSource): GatewayEnvironment | null {
  if (isGatewayEnvironment(payment.gateway_environment)) return payment.gateway_environment;

  const account = String(payment.gateway_account_key ?? "").trim();
  if (account && GATEWAY_ACCOUNT_ENVIRONMENT[account]) {
    return GATEWAY_ACCOUNT_ENVIRONMENT[account];
  }

  const provider = String(payment.provider ?? "").trim().toLowerCase();
  const gatewayId = String(payment.gateway_payment_id ?? "").trim();
  if (provider === "fake" || gatewayId.toLowerCase().startsWith("fake_")) return null;

  // Cobrancas Asaas anteriores ao multi-account (20260951) nao gravavam
  // account_key. Toda cobranca live posterior grava asaas-conta-live-01.
  if (provider === "asaas" && !account) return "sandbox";

  return null;
}

export function gatewayEnvironmentLabel(environment: GatewayEnvironment | null): "LIVE" | "SANDBOX" | null {
  if (environment === "production") return "LIVE";
  if (environment === "sandbox") return "SANDBOX";
  return null;
}
