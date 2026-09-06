import { createHash } from "node:crypto";

const LIVE_BASE = "https://api.asaas.com/v3";
const EXPECTED_HOSTS = new Set(["www.militrin.com.br", "militrin.com.br"]);

export type AsaasAccountSlotDiag = {
  auth: boolean;
  account: string | null;
  commercialSite: string | null;
  companyName: string | null;
};

export type AsaasAccountIdentityDiag = {
  pix: AsaasAccountSlotDiag;
  card: AsaasAccountSlotDiag;
  verdict: string;
};

function readEnv(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isMalformedApiKey(value: string): boolean {
  if (!value) return true;
  if (/[\r\n\0]/.test(value)) return true;
  return (value.match(/\$aact_/g) ?? []).length > 1;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sanitizeHostname(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const url = text.includes("://") ? new URL(text) : new URL(`https://${text}`);
    const host = url.hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
}

function safeCompanyName(raw: unknown): string | null {
  const name = String(raw ?? "").trim();
  if (!name || !/militrin/i.test(name)) return null;
  return name.slice(0, 80);
}

async function asaasGet(apiKey: string, path: string): Promise<{ ok: boolean; body: unknown }> {
  const response = await fetch(`${LIVE_BASE}${path}`, {
    method: "GET",
    headers: {
      access_token: apiKey,
      "User-Agent": "militrin-manager",
      Accept: "application/json",
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

function accountFingerprint(accountBody: unknown, commercialBody: unknown): string | null {
  const account = asRecord(accountBody);
  const commercial = asRecord(commercialBody);
  const id = String(account?.id ?? account?.walletId ?? "").trim();
  if (id) return `h:${shortHash(id)}`;
  const cpfCnpj = String(commercial?.cpfCnpj ?? "").trim();
  if (cpfCnpj) return `h:${shortHash(`doc:${cpfCnpj}`)}`;
  return null;
}

async function probeSlot(apiKey: string): Promise<AsaasAccountSlotDiag> {
  const empty: AsaasAccountSlotDiag = {
    auth: false,
    account: null,
    commercialSite: null,
    companyName: null,
  };
  if (isMalformedApiKey(apiKey)) return empty;

  try {
    const account = await asaasGet(apiKey, "/myAccount");
    let commercial = await asaasGet(apiKey, "/myAccount/commercialInfo/");
    if (!commercial.ok) {
      commercial = await asaasGet(apiKey, "/myAccount/commercialInfo");
    }
    const commercialRecord = asRecord(commercial.body);
    return {
      auth: account.ok,
      account: account.ok ? accountFingerprint(account.body, commercial.body) : null,
      commercialSite: commercial.ok ? sanitizeHostname(commercialRecord?.site) : null,
      companyName: commercial.ok
        ? safeCompanyName(commercialRecord?.companyName ?? commercialRecord?.tradingName)
        : null,
    };
  } catch {
    return empty;
  }
}

function matchesExpectedSite(site: string | null): boolean {
  return Boolean(site && EXPECTED_HOSTS.has(site));
}

export async function runAsaasAccountIdentityDiag(): Promise<AsaasAccountIdentityDiag> {
  const pix = await probeSlot(readEnv("ASAAS_PIX_API_KEY"));
  const card = await probeSlot(readEnv("ASAAS_CARD_API_KEY"));
  const pixOk = matchesExpectedSite(pix.commercialSite);
  const cardOk = matchesExpectedSite(card.commercialSite);

  let verdict = "BLOQUEADO — NENHUMA CREDENCIAL ESTÁ NA CONTA ESPERADA";
  if (pixOk && cardOk) {
    if (pix.account && card.account && pix.account === card.account) {
      verdict = "PIX E CARD ESTÃO NA MESMA CONTA CORRETA";
    } else {
      verdict =
        "BLOQUEADO — DUAS CONTAS ASAAS COM MESMO SITE; NECESSÁRIO IDENTIFICAR A CONTA FINANCEIRA OFICIAL";
    }
  } else if (pixOk && !cardOk) {
    verdict = "PIX É A CONTA CORRETA — SUBSTITUIR ASAAS_CARD_API_KEY";
  } else if (cardOk && !pixOk) {
    verdict = "CARD É A CONTA CORRETA — SUBSTITUIR ASAAS_PIX_API_KEY";
  }

  return { pix, card, verdict };
}
