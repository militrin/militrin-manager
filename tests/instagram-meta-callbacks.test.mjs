import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  generateInstagramDeletionConfirmationCode,
  INSTAGRAM_DATA_DELETION_STATUS_PATH,
  instagramDataDeletionStatusUrl,
  isValidInstagramConfirmationCode,
  processInstagramMetaCallbackPost,
} from "../src/lib/instagram/meta-callbacks.ts";
import { parseMetaSignedRequest, readSignedRequestFromUrlEncodedBody } from "../src/lib/instagram/signed-request.ts";

const SECRET = "militrin-local-meta-callback-secret";
const OTHER_SECRET = "another-local-secret-value";
const BASE_URL = "https://www.militrin.com.br";
const root = fileURLToPath(new URL("..", import.meta.url));

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function signPayload(payload, secret = SECRET) {
  const encodedPayload = encodePayload(payload);
  const encodedSignature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedSignature}.${encodedPayload}`;
}

function validPayload(userId = "17841400000000001") {
  return { algorithm: "HMAC-SHA256", user_id: userId };
}

function createMemoryStore(seed = {}) {
  const integrations = (seed.integrations ?? []).map((row) => ({ ...row }));
  const giveaways = (seed.giveaways ?? []).map((row) => ({ ...row }));
  const entries = (seed.entries ?? []).map((row) => ({ ...row }));
  const audits = [];
  const deletions = [];

  return {
    integrations,
    giveaways,
    entries,
    audits,
    deletions,
    async deauthorize(instagramUserId) {
      const matched = integrations.filter((row) => row.instagram_user_id === instagramUserId);
      const disconnectedNow = matched.filter((row) => row.disconnected_at == null).length;
      const alreadyDisconnected = matched.filter((row) => row.disconnected_at != null).length;
      for (const row of matched) {
        if (row.disconnected_at == null) {
          row.encrypted_access_token = null;
          row.disconnected_at = "2026-09-08T00:00:00.000Z";
        }
      }
      audits.push({ action: "INSTAGRAM_DEAUTHORIZED", instagramUserId, disconnectedNow, alreadyDisconnected });
      return { disconnectedNow, alreadyDisconnected };
    },
    async requestDataDeletion(instagramUserId, confirmationCode) {
      const existing = deletions.find((row) => row.instagram_user_id === instagramUserId);
      if (existing) return { confirmationCode: existing.confirmation_code, reused: true };
      const created = {
        confirmation_code: confirmationCode,
        instagram_user_id: instagramUserId,
        status: "credentials_revoked",
        created_at: "2026-09-08T00:00:00.000Z",
      };
      deletions.push(created);
      for (const row of integrations.filter((item) => item.instagram_user_id === instagramUserId)) {
        row.encrypted_access_token = null;
        row.disconnected_at = row.disconnected_at ?? "2026-09-08T00:00:00.000Z";
        row.instagram_username = "deleted";
        row.instagram_user_id = `deleted:${row.id}`;
      }
      audits.push({ action: "INSTAGRAM_DATA_DELETION_REQUESTED", instagramUserId, confirmationCode });
      return { confirmationCode, reused: false };
    },
    async getPublicStatus(confirmationCode) {
      const found = deletions.find((row) => row.confirmation_code === confirmationCode);
      if (!found) return null;
      return { status: found.status, createdAt: found.created_at };
    },
  };
}

function formBody(signedRequest) {
  return new URLSearchParams({ signed_request: signedRequest }).toString();
}

async function postCallback(kind, signedRequest, store, contentType = "application/x-www-form-urlencoded") {
  return processInstagramMetaCallbackPost(formBody(signedRequest), contentType, {
    appSecret: SECRET,
    store,
    kind,
    baseUrl: BASE_URL,
  });
}

async function collectFiles(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      await collectFiles(full, files);
    } else if (/\.(tsx?|jsx?|mjs|css)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

test("signed_request valido devolve user_id", () => {
  const signed = signPayload(validPayload("42"));
  const parsed = parseMetaSignedRequest(signed, SECRET);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.payload.user_id, "42");
    assert.equal(parsed.payload.algorithm, "HMAC-SHA256");
  }
});

test("assinatura HMAC usa a segunda parte original do signed_request", () => {
  const encodedPayload = encodePayload(validPayload("99"));
  const encodedSignature = createHmac("sha256", SECRET).update(encodedPayload).digest("base64url");
  const parsed = parseMetaSignedRequest(`${encodedSignature}.${encodedPayload}`, SECRET);
  assert.equal(parsed.ok, true);
});

test("assinatura invalida retorna 401", () => {
  const signed = signPayload(validPayload(), OTHER_SECRET);
  const parsed = parseMetaSignedRequest(signed, SECRET);
  assert.deepEqual(parsed, { ok: false, status: 401, reason: "signature" });
});

test("algoritmo errado retorna 400", () => {
  const signed = signPayload({ algorithm: "HMAC-SHA1", user_id: "1" });
  const parsed = parseMetaSignedRequest(signed, SECRET);
  assert.deepEqual(parsed, { ok: false, status: 400, reason: "algorithm" });
});

test("payload malformado retorna 400", () => {
  assert.equal(parseMetaSignedRequest("abc", SECRET).ok, false);
  assert.equal(parseMetaSignedRequest("a.b.c", SECRET).ok, false);
  assert.equal(parseMetaSignedRequest("abc.%%%", SECRET).ok, false);
  const encodedPayload = Buffer.from("{", "utf8").toString("base64url");
  const encodedSignature = createHmac("sha256", SECRET).update(encodedPayload).digest("base64url");
  assert.deepEqual(parseMetaSignedRequest(`${encodedSignature}.${encodedPayload}`, SECRET), {
    ok: false,
    status: 400,
    reason: "malformed",
  });
});

test("base64url sem padding e user_id numerico sao aceitos", () => {
  const parsed = parseMetaSignedRequest(signPayload({ algorithm: "HMAC-SHA256", user_id: 1784140001 }), SECRET);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.payload.user_id, "1784140001");
});

test("comparacao timing-safe nao lanca em tamanhos diferentes", () => {
  const encodedPayload = encodePayload(validPayload());
  const shortSig = Buffer.from("aa").toString("base64url");
  const parsed = parseMetaSignedRequest(`${shortSig}.${encodedPayload}`, SECRET);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.status, 401);
});

test("form-urlencoded expoe somente o campo signed_request", () => {
  const signed = signPayload(validPayload());
  assert.equal(readSignedRequestFromUrlEncodedBody(`signed_request=${encodeURIComponent(signed)}`), signed);
  assert.equal(readSignedRequestFromUrlEncodedBody("foo=bar"), null);
});

test("DEAUTHORIZE valido desconecta integracao e preserva historico", async () => {
  const store = createMemoryStore({
    integrations: [{ id: "i1", instagram_user_id: "ig-1", instagram_username: "militrinoktober", encrypted_access_token: "cipher", disconnected_at: null }],
    giveaways: [{ id: "g1", instagram_integration_id: "i1" }],
    entries: [{ id: "e1", giveaway_id: "g1", comment_id: "c1" }],
  });
  const response = await postCallback("deauthorize", signPayload(validPayload("ig-1")), store);
  assert.equal(response.status, 200);
  assert.equal(store.integrations[0].encrypted_access_token, null);
  assert.ok(store.integrations[0].disconnected_at);
  assert.equal(store.giveaways.length, 1);
  assert.equal(store.entries.length, 1);
  assert.equal(store.audits[0].action, "INSTAGRAM_DEAUTHORIZED");
});

test("DEAUTHORIZE valido sem integracao responde 200", async () => {
  const store = createMemoryStore();
  const response = await postCallback("deauthorize", signPayload(validPayload("missing")), store);
  assert.equal(response.status, 200);
  assert.equal(store.integrations.length, 0);
});

test("DEAUTHORIZE repetido e idempotente", async () => {
  const store = createMemoryStore({
    integrations: [{ id: "i1", instagram_user_id: "ig-1", encrypted_access_token: "cipher", disconnected_at: null }],
    giveaways: [{ id: "g1" }],
  });
  const signed = signPayload(validPayload("ig-1"));
  const first = await postCallback("deauthorize", signed, store);
  const disconnectedAt = store.integrations[0].disconnected_at;
  const second = await postCallback("deauthorize", signed, store);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(store.integrations[0].disconnected_at, disconnectedAt);
  assert.equal(store.giveaways.length, 1);
});

test("DEAUTHORIZE com assinatura invalida retorna 401", async () => {
  const store = createMemoryStore();
  const response = await postCallback("deauthorize", signPayload(validPayload(), OTHER_SECRET), store);
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: "Requisicao invalida." });
});

test("DATA DELETION valido devolve url e confirmation_code", async () => {
  const store = createMemoryStore({
    integrations: [{ id: "i1", instagram_user_id: "ig-9", instagram_username: "militrinoktober", encrypted_access_token: "cipher", disconnected_at: null }],
    giveaways: [{ id: "g1", instagram_integration_id: "i1" }],
  });
  const response = await postCallback("data-deletion", signPayload(validPayload("ig-9")), store);
  assert.equal(response.status, 200);
  const body = response.body ?? {};
  assert.equal(typeof body.confirmation_code, "string");
  assert.equal(isValidInstagramConfirmationCode(String(body.confirmation_code)), true);
  assert.equal(body.url, instagramDataDeletionStatusUrl(String(body.confirmation_code), BASE_URL));
  assert.match(String(body.url), new RegExp(`^${BASE_URL}${INSTAGRAM_DATA_DELETION_STATUS_PATH}/`));
  assert.equal(store.integrations[0].encrypted_access_token, null);
  assert.equal(store.integrations[0].instagram_username, "deleted");
  assert.match(store.integrations[0].instagram_user_id, /^deleted:/);
  assert.equal(store.giveaways.length, 1);
  const status = await store.getPublicStatus(String(body.confirmation_code));
  assert.equal(status?.status, "credentials_revoked");
  assert.equal("instagram_user_id" in (status ?? {}), false);
});

test("DATA DELETION invalido retorna 401 e nao cria pedido", async () => {
  const store = createMemoryStore();
  const response = await postCallback("data-deletion", signPayload(validPayload(), OTHER_SECRET), store);
  assert.equal(response.status, 401);
  assert.equal(store.deletions.length, 0);
});

test("DATA DELETION repetido devolve o mesmo confirmation_code", async () => {
  const store = createMemoryStore({
    integrations: [{ id: "i1", instagram_user_id: "ig-2", encrypted_access_token: "cipher", disconnected_at: null }],
  });
  const signed = signPayload(validPayload("ig-2"));
  const first = await postCallback("data-deletion", signed, store);
  const second = await postCallback("data-deletion", signed, store);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body?.confirmation_code, first.body?.confirmation_code);
  assert.equal(second.body?.url, first.body?.url);
  assert.equal(store.deletions.length, 1);
});

test("codigo de confirmacao tem entropia suficiente e pagina de status nao enumeravel por codigo curto", () => {
  const code = generateInstagramDeletionConfirmationCode();
  assert.equal(isValidInstagramConfirmationCode(code), true);
  assert.ok(code.length >= 43);
  assert.equal(isValidInstagramConfirmationCode("abc"), false);
});

test("rotas Meta sao POST publicas e OAuth continua GET", async () => {
  const deauthorize = await readFile(path.join(root, "src/app/api/instagram/deauthorize/route.ts"), "utf8");
  const deletion = await readFile(path.join(root, "src/app/api/instagram/data-deletion/route.ts"), "utf8");
  const oauth = await readFile(path.join(root, "src/app/api/instagram/oauth/callback/route.ts"), "utf8");
  const middleware = await readFile(path.join(root, "middleware.ts"), "utf8");
  const statusPage = await readFile(path.join(root, "src/app/exclusao-de-dados/status/[confirmationCode]/page.tsx"), "utf8");
  const publicForm = await readFile(path.join(root, "src/app/exclusao-de-dados/page.tsx"), "utf8");

  assert.match(deauthorize, /export async function POST/);
  assert.doesNotMatch(deauthorize, /export async function GET/);
  assert.match(deletion, /export async function POST/);
  assert.match(oauth, /export async function GET/);
  assert.match(middleware, /\/api\/instagram\/oauth\/callback/);
  assert.match(middleware, /\/api\/instagram\/deauthorize/);
  assert.match(middleware, /\/api\/instagram\/data-deletion/);
  assert.match(middleware, /isPublicMetaCallback/);
  assert.doesNotMatch(statusPage, /requireAdministrativePanelAccess|requirePermission/);
  assert.match(statusPage, /Solicitação não encontrada/);
  assert.doesNotMatch(statusPage, /instagram_user_id|encrypted_access_token|META_INSTAGRAM_APP_SECRET|signed_request/);
  assert.match(publicForm, /DataDeletionRequestForm/);
});

test("META_INSTAGRAM_APP_SECRET nao aparece em componentes client", async () => {
  const files = await collectFiles(path.join(root, "src"));
  const leaks = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const isClient = source.includes('"use client"') || source.includes("'use client'");
    if (!isClient) continue;
    if (source.includes("META_INSTAGRAM_APP_SECRET") || source.includes("INSTAGRAM_TOKEN_ENCRYPTION_KEY")) {
      leaks.push(path.relative(root, file));
    }
  }
  assert.deepEqual(leaks, []);
});
