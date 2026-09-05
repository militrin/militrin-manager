import { cardPaymentReturnUrl } from "@/lib/payments/card-return-url";
import { getAsaasEnvironment } from "@/lib/payments/asaas-account-registry";

const LIVE_BASE = "https://api.asaas.com/v3";
const EXPECTED_WEBHOOK_URL = "https://www.militrin.com.br/api/webhooks/asaas";
const WEBHOOK_NAME_NEEDLE = "militrin produ";

const REQUIRED_WEBHOOK_EVENTS = [
  "PAYMENT_CREATED",
  "PAYMENT_CONFIRMED",
  "PAYMENT_RECEIVED",
  "PAYMENT_DELETED",
  "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED",
  "PAYMENT_AWAITING_RISK_ANALYSIS",
  "PAYMENT_APPROVED_BY_RISK_ANALYSIS",
  "PAYMENT_REPROVED_BY_RISK_ANALYSIS",
] as const;

export type AsaasLivePreflightDiag = {
  env: "production" | "sandbox";
  pixAuth: boolean;
  cardAuth: boolean;
  sameAccount: boolean;
  commercialSite: string | null;
  webhookFound: boolean;
  webhookEnabled: boolean | null;
  webhookInterrupted: boolean | null;
  webhookUrlOk: boolean;
  requiredEventsOk: boolean;
  callbackCodeOk: boolean;
};

function readEnv(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function accountId(body: unknown): string | null {
  const rec = asRecord(body);
  if (!rec) return null;
  const walletId = String(rec.walletId ?? "").trim();
  if (walletId) return walletId;
  const id = String(rec.id ?? "").trim();
  return id || null;
}

function sanitizeHostname(raw: unknown): string | null {
  const site = String(raw ?? "").trim();
  if (!site) return null;
  try {
    const url = site.includes("://") ? new URL(site) : new URL(`https://${site}`);
    const host = url.hostname.trim().toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

function callbackCodeOk(): boolean {
  const probeOrderId = "pedido-preflight";
  const expected = `https://www.militrin.com.br/pagamento/retorno?pedido=${probeOrderId}`;
  return cardPaymentReturnUrl(probeOrderId) === expected;
}

async function asaasGet(apiKey: string, path: string): Promise<{ ok: boolean; body: unknown | null }> {
  const response = await fetch(`${LIVE_BASE}${path}`, {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "User-Agent": "militrin-manager",
      access_token: apiKey,
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { ok: response.ok, body };
}

function emptyResult(env: "production" | "sandbox"): AsaasLivePreflightDiag {
  return {
    env,
    pixAuth: false,
    cardAuth: false,
    sameAccount: false,
    commercialSite: null,
    webhookFound: false,
    webhookEnabled: null,
    webhookInterrupted: null,
    webhookUrlOk: false,
    requiredEventsOk: false,
    callbackCodeOk: callbackCodeOk(),
  };
}

function findMilitrinWebhook(body: unknown): Record<string, unknown> | null {
  const rec = asRecord(body);
  const data = Array.isArray(rec?.data) ? rec.data : [];
  for (const item of data) {
    const webhook = asRecord(item);
    if (!webhook) continue;
    const name = String(webhook.name ?? "").trim().toLowerCase();
    if (name.includes(WEBHOOK_NAME_NEEDLE) || name === "militrin produção") return webhook;
  }
  return null;
}

function relevantEvents(webhook: Record<string, unknown>): string[] {
  return Array.isArray(webhook.events)
    ? webhook.events.map((event) => String(event ?? "").trim()).filter(Boolean)
    : [];
}

export async function runAsaasLivePreflightDiag(): Promise<AsaasLivePreflightDiag> {
  const env = getAsaasEnvironment();
  const result = emptyResult(env);
  if (env !== "production") return result;

  const pixKey = readEnv("ASAAS_PIX_API_KEY");
  const cardKey = readEnv("ASAAS_CARD_API_KEY");

  const [pixAccount, cardAccount] = await Promise.all([
    pixKey ? asaasGet(pixKey, "/myAccount") : Promise.resolve({ ok: false, body: null }),
    cardKey ? asaasGet(cardKey, "/myAccount") : Promise.resolve({ ok: false, body: null }),
  ]);

  result.pixAuth = pixAccount.ok;
  result.cardAuth = cardAccount.ok;

  const pixId = result.pixAuth ? accountId(pixAccount.body) : null;
  const cardId = result.cardAuth ? accountId(cardAccount.body) : null;
  result.sameAccount = Boolean(pixId && cardId && pixId === cardId);

  const infoKey = pixKey || cardKey;
  if (infoKey) {
    let commercial = await asaasGet(infoKey, "/myAccount/commercialInfo");
    if (!commercial.ok) {
      commercial = await asaasGet(infoKey, "/myAccount/commercialInfo/");
    }
    if (commercial.ok) {
      result.commercialSite = sanitizeHostname(asRecord(commercial.body)?.site);
    }

    const webhooks = await asaasGet(infoKey, "/webhooks");
    if (webhooks.ok) {
      const webhook = findMilitrinWebhook(webhooks.body);
      if (webhook) {
        result.webhookFound = true;
        result.webhookEnabled = Boolean(webhook.enabled);
        result.webhookInterrupted = Boolean(webhook.interrupted);
        const url = String(webhook.url ?? "").trim();
        result.webhookUrlOk = url === EXPECTED_WEBHOOK_URL;
        const events = relevantEvents(webhook);
        result.requiredEventsOk = REQUIRED_WEBHOOK_EVENTS.every((event) => events.includes(event));
      }
    }
  }

  return result;
}
