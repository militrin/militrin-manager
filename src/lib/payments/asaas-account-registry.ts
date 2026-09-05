import type { AsaasEnvironment } from "./asaas-provider.ts";
import { getHeader, type HeaderBag } from "./http-headers.ts";
import { timingSafeEqualString } from "./asaas-webhook-token.ts";

/**
 * Metodo de checkout que seleciona QUAL conta Asaas criar a cobranca.
 * `account_key` representa a conta, nao o metodo: PIX e cartao podem
 * compartilhar o mesmo rotulo quando forem a mesma conta Asaas.
 */
export type AsaasCheckoutMethod = "pix" | "credit_card";

export class GatewayAccountNotConfiguredError extends Error {
  readonly accountKey: string;

  constructor(accountKey: string) {
    const label = accountKey.trim() || "(vazio)";
    super(
      `Conta de gateway historica nao configurada (account_key=${label}). Nao e possivel operar nesta cobranca com as credenciais ativas.`,
    );
    this.name = "GatewayAccountNotConfiguredError";
    this.accountKey = label;
  }
}

export type AsaasAccountCredentials = {
  accountKey: string;
  apiKey: string;
  webhookToken: string;
  webhookTokens: string[];
  environment: AsaasEnvironment;
  methods: AsaasCheckoutMethod[];
};

function readEnv(name: string): string {
  return String(process.env[name] ?? "").trim();
}

export function getAsaasEnvironment(): AsaasEnvironment {
  return readEnv("ASAAS_ENVIRONMENT").toLowerCase() === "production" ? "production" : "sandbox";
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

type MethodSlot = {
  accountKey: string;
  apiKey: string;
  webhookToken: string;
  method: AsaasCheckoutMethod;
};

function pixSlot(): MethodSlot | null {
  const accountKey = readEnv("ASAAS_PIX_ACCOUNT_KEY") || readEnv("ASAAS_ACCOUNT_KEY");
  const apiKey = readEnv("ASAAS_PIX_API_KEY") || readEnv("ASAAS_API_KEY");
  const webhookToken = readEnv("ASAAS_PIX_WEBHOOK_TOKEN") || readEnv("ASAAS_WEBHOOK_TOKEN");
  if (!accountKey || !apiKey || !webhookToken) return null;
  return { accountKey, apiKey, webhookToken, method: "pix" };
}

function cardSlot(): MethodSlot | null {
  const accountKey = readEnv("ASAAS_CARD_ACCOUNT_KEY") || readEnv("ASAAS_ACCOUNT_KEY");
  const apiKey = readEnv("ASAAS_CARD_API_KEY") || readEnv("ASAAS_API_KEY");
  const webhookToken = readEnv("ASAAS_CARD_WEBHOOK_TOKEN") || readEnv("ASAAS_WEBHOOK_TOKEN");
  if (!accountKey || !apiKey || !webhookToken) return null;
  return { accountKey, apiKey, webhookToken, method: "credit_card" };
}

/**
 * Registry account_key → credencial. PIX e cartao com o MESMO account_key
 * compartilham a mesma entrada. O trio legado ASAAS_* permanece no mapa
 * quando o rotulo historico e diferente dos rotulos por metodo, para
 * consultar/cancelar cobrancas Gate #1 sem reescrever historico.
 *
 * Ambiente e compartilhado (`ASAAS_ENVIRONMENT`). Contas distintas em
 * sandbox vs production exigiria desenho extra — nao implementado.
 */
export function listConfiguredAsaasAccounts(): AsaasAccountCredentials[] {
  const environment = getAsaasEnvironment();
  const byKey = new Map<string, AsaasAccountCredentials>();

  function add(slot: MethodSlot | null) {
    if (!slot) return;
    const existing = byKey.get(slot.accountKey);
    if (!existing) {
      byKey.set(slot.accountKey, {
        accountKey: slot.accountKey,
        apiKey: slot.apiKey,
        webhookToken: slot.webhookToken,
        webhookTokens: [slot.webhookToken],
        environment,
        methods: [slot.method],
      });
      return;
    }
    if (existing.apiKey !== slot.apiKey) {
      throw new Error(
        `ASAAS: account_key=${slot.accountKey} nao pode ter API keys diferentes por metodo. account_key representa a conta Asaas, nao o meio de pagamento.`,
      );
    }
    if (!existing.methods.includes(slot.method)) existing.methods.push(slot.method);
    if (!existing.webhookTokens.includes(slot.webhookToken)) {
      existing.webhookTokens.push(slot.webhookToken);
    }
  }

  add(pixSlot());
  add(cardSlot());

  const legacyKey = readEnv("ASAAS_ACCOUNT_KEY");
  const legacyApi = readEnv("ASAAS_API_KEY");
  const legacyToken = readEnv("ASAAS_WEBHOOK_TOKEN");
  if (legacyKey && legacyApi && legacyToken && !byKey.has(legacyKey)) {
    byKey.set(legacyKey, {
      accountKey: legacyKey,
      apiKey: legacyApi,
      webhookToken: legacyToken,
      webhookTokens: [legacyToken],
      environment,
      methods: ["pix"],
    });
  }

  const previousToken = readEnv("ASAAS_WEBHOOK_TOKEN_PREVIOUS");
  if (previousToken) {
    const rotationTarget =
      byKey.get(readEnv("ASAAS_ACCOUNT_KEY")) ??
      byKey.get(readEnv("ASAAS_PIX_ACCOUNT_KEY")) ??
      [...byKey.values()].find((account) => account.methods.includes("pix"));
    if (rotationTarget && !rotationTarget.webhookTokens.includes(previousToken)) {
      rotationTarget.webhookTokens.push(previousToken);
    }
  }

  return [...byKey.values()];
}

export function getAsaasAccountCredentialsForMethod(method: AsaasCheckoutMethod): AsaasAccountCredentials | null {
  return listConfiguredAsaasAccounts().find((account) => account.methods.includes(method)) ?? null;
}

export function getAsaasAccountCredentialsForAccountKey(
  accountKey: string | null | undefined,
): AsaasAccountCredentials | null {
  const stored = String(accountKey ?? "").trim();
  if (!stored) return null;
  return listConfiguredAsaasAccounts().find((account) => account.accountKey === stored) ?? null;
}

export function getPaymentGatewayAccountKeyForMethod(method: AsaasCheckoutMethod): string | null {
  return getAsaasAccountCredentialsForMethod(method)?.accountKey ?? null;
}

export function isConfiguredGatewayAccountKey(storedAccountKey: string | null | undefined): boolean {
  return getAsaasAccountCredentialsForAccountKey(storedAccountKey) != null;
}

/**
 * Token do header `asaas-access-token` → account_key.
 * Tokens iguais em contas diferentes sao rejeitados (ambiguo).
 */
export function resolveAsaasWebhookAccountKey(headers: HeaderBag): string | null {
  const token = getHeader(headers, "asaas-access-token");
  if (!token) return null;

  const matches = uniqueNonEmpty(
    listConfiguredAsaasAccounts().flatMap((account) =>
      account.webhookTokens.some((candidate) => timingSafeEqualString(token, candidate))
        ? [account.accountKey]
        : [],
    ),
  );

  if (matches.length === 1) return matches[0] ?? null;
  if (matches.length > 1) {
    throw new Error("Token de webhook Asaas corresponde a mais de uma conta configurada.");
  }
  return null;
}
