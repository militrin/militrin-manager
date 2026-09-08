import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { processInstagramOAuthCallback } from "../src/lib/instagram/oauth-callback.ts";
import { INSTAGRAM_OAUTH_STATE_COOKIE, instagramOAuthStateCookieOptions, isValidInstagramOAuthState, oauthStatesMatch } from "../src/lib/instagram/oauth-cookie.ts";
import { inspectInstagramRuntimeConfig, REQUIRED_META_GRAPH_API_VERSION, CANONICAL_INSTAGRAM_OAUTH_REDIRECT_URI, inspectInstagramRedirectUri, readInstagramRedirectUri, requireInstagramRedirectUri } from "../src/lib/instagram/oauth-config.ts";
import { instagramRedirectUriDiagnostics } from "../src/lib/instagram/oauth-log.ts";
import { InstagramOAuthError } from "../src/lib/instagram/oauth-errors.ts";
import {
  INSTAGRAM_OAUTH_ERROR_MESSAGE,
  INSTAGRAM_OAUTH_SUCCESS_MESSAGE,
  instagramOAuthRedirectSearch,
  resolveInstagramOAuthFeedback,
} from "../src/lib/instagram/oauth-feedback.ts";
import { sanitizeMetaErrorMessage, readMetaError } from "../src/lib/instagram/meta-error.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function nonce() {
  return randomBytes(32).toString("base64url");
}

function createMemoryStore(seed = {}) {
  const states = new Map();
  for (const row of seed.states ?? []) {
    states.set(row.state, { ...row, consumedAt: row.consumedAt ?? null });
  }
  const integrations = [];
  const logs = [];
  return {
    states,
    integrations,
    logs,
    allowed: seed.allowed ?? true,
    failConnect: seed.failConnect ?? false,
    async createContext(input) {
      states.set(input.state, { ...input, consumedAt: null });
    },
    async consumeContext(state, now) {
      const row = states.get(state);
      if (!row || row.consumedAt || row.expiresAt <= now) return null;
      row.consumedAt = now;
      return { adminUserId: row.adminUserId, organizationId: row.organizationId };
    },
    async userCanAccessOrganization() {
      return this.allowed;
    },
    async connectIntegration(input) {
      if (this.failConnect) throw new Error("db upsert failed");
      integrations.push(input);
    },
  };
}

function exchanged(overrides = {}) {
  return {
    accessToken: "ig-long-lived-token",
    expiresIn: 5184000,
    profile: { id: "17841400000000001", username: "militrinoktober", ...overrides.profile },
    ...overrides,
  };
}

async function runCallback(input, seed = {}, deps = {}) {
  const store = createMemoryStore(seed);
  const logs = [];
  const result = await processInstagramOAuthCallback(
    {
      code: "ok-code",
      state: seed.state ?? nonce(),
      cookieState: null,
      ...input,
    },
    {
      store,
      isConfigured: () => true,
      exchangeCode: deps.exchangeCode ?? (async () => exchanged()),
      encryptToken: deps.encryptToken ?? ((token) => `enc.${token.length}`),
      log: (stage, meta) => logs.push({ stage, meta }),
      now: () => seed.now ?? new Date("2026-09-08T03:30:00.000Z"),
    },
  );
  return { result, store, logs };
}

function validContext(state, overrides = {}) {
  return {
    state,
    adminUserId: "11111111-1111-1111-1111-111111111111",
    organizationId: "22222222-2222-2222-2222-222222222222",
    expiresAt: new Date("2026-09-08T03:40:00.000Z"),
    ...overrides,
  };
}

test("env Instagram exige App ID/Secret, redirect, Graph v26.0 e chave >= 32", () => {
  assert.equal(REQUIRED_META_GRAPH_API_VERSION, "v26.0");
  const missing = inspectInstagramRuntimeConfig({});
  assert.equal(missing.configured, false);
  assert.equal(missing.appId, false);
  const ok = inspectInstagramRuntimeConfig({
    META_INSTAGRAM_APP_ID: "123",
    META_INSTAGRAM_APP_SECRET: "secret-value",
    META_INSTAGRAM_REDIRECT_URI: "https://www.militrin.com.br/api/instagram/oauth/callback",
    META_GRAPH_API_VERSION: "v26.0",
    INSTAGRAM_TOKEN_ENCRYPTION_KEY: "x".repeat(32),
  });
  assert.equal(ok.configured, true);
  const wrongVersion = inspectInstagramRuntimeConfig({
    META_INSTAGRAM_APP_ID: "123",
    META_INSTAGRAM_APP_SECRET: "secret-value",
    META_INSTAGRAM_REDIRECT_URI: "https://www.militrin.com.br/api/instagram/oauth/callback",
    META_GRAPH_API_VERSION: "v21.0",
    INSTAGRAM_TOKEN_ENCRYPTION_KEY: "x".repeat(32),
  });
  assert.equal(wrongVersion.graphApiVersion, false);
  assert.equal(wrongVersion.configured, false);
});

test("cookie OAuth usa Path=/, HttpOnly, SameSite=Lax e comparacao segura", () => {
  const options = instagramOAuthStateCookieOptions();
  assert.equal(options.path, "/");
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.maxAge, 600);
  assert.equal(INSTAGRAM_OAUTH_STATE_COOKIE, "instagram_oauth_state");
  const state = nonce();
  assert.equal(isValidInstagramOAuthState(state), true);
  assert.equal(oauthStatesMatch(state, state), true);
  assert.equal(oauthStatesMatch(state, nonce()), false);
});

test("callback com contexto server-side valido e sem cookie de sessao conclui", async () => {
  const state = nonce();
  const { result, store, logs } = await runCallback(
    { state, cookieState: null, code: "ok-code" },
    { states: [validContext(state)] },
  );
  assert.deepEqual(result, { instagram: "connected" });
  assert.equal(store.integrations.length, 1);
  assert.equal(store.integrations[0].instagramUsername, "militrinoktober");
  assert.equal(store.states.get(state).consumedAt != null, true);
  assert.equal(logs[0].stage, "oauth_callback_received");
  assert.equal(logs.at(-1).stage, "oauth_connected");
});

test("callback com cookie de state valido tambem conclui", async () => {
  const state = nonce();
  const { result } = await runCallback(
    { state, cookieState: state, code: "ok-code" },
    { states: [validContext(state)] },
  );
  assert.deepEqual(result, { instagram: "connected" });
});

test("state invalido nao troca token", async () => {
  const { result, store, logs } = await runCallback({ state: "nope", cookieState: null, code: "ok-code" });
  assert.deepEqual(result, { instagram: "error", reason: "state" });
  assert.equal(store.integrations.length, 0);
  assert.ok(logs.some((item) => item.stage === "oauth_state_invalid"));
});

test("cookie de state divergente e rejeitado", async () => {
  const state = nonce();
  const { result, store } = await runCallback(
    { state, cookieState: nonce(), code: "ok-code" },
    { states: [validContext(state)] },
  );
  assert.deepEqual(result, { instagram: "error", reason: "state" });
  assert.equal(store.integrations.length, 0);
  assert.equal(store.states.get(state).consumedAt, null);
});

test("contexto ausente ou expirado nao depende da sessao do browser", async () => {
  const state = nonce();
  const expired = await runCallback(
    { state, cookieState: null, code: "ok-code" },
    { states: [validContext(state, { expiresAt: new Date("2026-09-08T03:00:00.000Z") })], now: new Date("2026-09-08T03:30:00.000Z") },
  );
  assert.deepEqual(expired.result, { instagram: "error", reason: "session" });
  assert.ok(expired.logs.some((item) => item.stage === "oauth_context_missing"));

  const missing = await runCallback({ state: nonce(), cookieState: null, code: "ok-code" });
  assert.deepEqual(missing.result, { instagram: "error", reason: "session" });
});

test("code ausente, token, profile, encrypt e upsert falham nos estagios certos", async () => {
  const state = nonce();
  const missingCode = await runCallback(
    { state, cookieState: null, code: "" },
    { states: [validContext(state)] },
  );
  assert.deepEqual(missingCode.result, { instagram: "error", reason: "token" });
  assert.ok(missingCode.logs.some((item) => item.stage === "oauth_code_missing"));

  const token = await runCallback(
    { state, cookieState: null, code: "ok-code" },
    { states: [validContext(state)] },
    {
      exchangeCode: async () => {
        throw new InstagramOAuthError("oauth_token_exchange_failed", "token", "fail", {
          httpStatus: 400,
          errorCode: 100,
          errorType: "OAuthException",
          sanitizedMessage: "invalid_grant",
        });
      },
    },
  );
  assert.deepEqual(token.result, { instagram: "error", reason: "token" });
  assert.ok(token.logs.some((item) => item.stage === "oauth_token_exchange_failed" && item.meta?.httpStatus === 400));

  const profileState = nonce();
  const profile = await runCallback(
    { state: profileState, cookieState: null, code: "ok-code" },
    { states: [validContext(profileState)] },
    {
      exchangeCode: async () => {
        throw new InstagramOAuthError("oauth_profile_fetch_failed", "profile", "fail", {
          httpStatus: 400,
          errorCode: 190,
          sanitizedMessage: "perfil_invalido",
        });
      },
    },
  );
  assert.deepEqual(profile.result, { instagram: "error", reason: "profile" });

  const encryptState = nonce();
  const encrypt = await runCallback(
    { state: encryptState, cookieState: null, code: "ok-code" },
    { states: [validContext(encryptState)] },
    { encryptToken: () => { throw new Error("key"); } },
  );
  assert.deepEqual(encrypt.result, { instagram: "error", reason: "storage" });
  assert.ok(encrypt.logs.some((item) => item.stage === "oauth_encrypt_failed"));

  const dbState = nonce();
  const db = await runCallback(
    { state: dbState, cookieState: null, code: "ok-code" },
    { states: [validContext(dbState)], failConnect: true },
  );
  assert.deepEqual(db.result, { instagram: "error", reason: "storage" });
  assert.ok(db.logs.some((item) => item.stage === "oauth_db_upsert_failed"));
});

test("redirect de sucesso e erro usa reason curto e nao poe exception na URL", () => {
  assert.equal(instagramOAuthRedirectSearch({ instagram: "connected" }), "instagram=connected");
  assert.equal(instagramOAuthRedirectSearch({ instagram: "error", reason: "state" }), "instagram=error&reason=state");
  assert.doesNotMatch(instagramOAuthRedirectSearch({ instagram: "error", reason: "unknown" }), /message=/);
  assert.equal(resolveInstagramOAuthFeedback("connected", null)?.message, INSTAGRAM_OAUTH_SUCCESS_MESSAGE);
  assert.equal(resolveInstagramOAuthFeedback("error", "state")?.message, INSTAGRAM_OAUTH_ERROR_MESSAGE);
  assert.equal(resolveInstagramOAuthFeedback("error", "stack-trace-here")?.reason, "unknown");
  assert.equal(resolveInstagramOAuthFeedback(undefined, undefined), null);
});

test("mensagem Meta e sanitizada e nao vaza token/code", () => {
  const sanitized = sanitizeMetaErrorMessage("bad https://graph.instagram.com/me?access_token=SECRETCODEVALUE1234567890 boom");
  assert.doesNotMatch(sanitized, /SECRETCODEVALUE/);
  assert.match(sanitized, /\[url\]|\[redacted\]/);
  const meta = readMetaError(400, { error: { code: 190, type: "OAuthException", message: "Invalid oauth access token" } });
  assert.equal(meta.httpStatus, 400);
  assert.equal(meta.errorCode, 190);
  assert.equal(meta.errorType, "OAuthException");
});

test("middleware, cookie, callback e UI de feedback estao ligados", async () => {
  const [middleware, actions, route, page, feedback, messages, metaApi] = await Promise.all([
    readFile(path.join(root, "middleware.ts"), "utf8"),
    readFile(path.join(root, "src/app/sorteios/actions.ts"), "utf8"),
    readFile(path.join(root, "src/app/api/instagram/oauth/callback/route.ts"), "utf8"),
    readFile(path.join(root, "src/app/sorteios/page.tsx"), "utf8"),
    readFile(path.join(root, "src/components/sorteios/InstagramOAuthFeedback.tsx"), "utf8"),
    readFile(path.join(root, "src/lib/instagram/oauth-feedback.ts"), "utf8"),
    readFile(path.join(root, "src/lib/instagram/meta-api.ts"), "utf8"),
  ]);

  const publicBlock = middleware.slice(middleware.indexOf("const publicMetaCallbackPaths"), middleware.indexOf("const isPublicMetaCallback"));
  assert.match(publicBlock, /\/api\/instagram\/oauth\/callback/);
  assert.match(publicBlock, /\/api\/instagram\/deauthorize/);
  assert.match(publicBlock, /\/api\/instagram\/data-deletion/);
  assert.match(middleware, /\/api\/instagram/);
  assert.match(middleware, /isProtectedApi = !isPublicMetaCallback/);

  assert.match(actions, /instagramOAuthStateCookieOptions\(\)/);
  assert.match(actions, /createSupabaseInstagramOAuthStore\(\)\.createContext/);
  assert.doesNotMatch(actions, /path:\s*"\/api\/instagram\/oauth\/callback"/);

  assert.match(route, /export async function GET/);
  assert.match(route, /processInstagramOAuthCallback/);
  assert.doesNotMatch(route, /getUser\(/);
  assert.doesNotMatch(route, /searchParams\.set\("message"/);
  assert.match(route, /instagramOAuthRedirectSearch/);
  assert.match(route, /instagramOAuthStateCookieOptions\(0\)/);

  assert.match(page, /searchParams: Promise<\{ instagram\?: string; reason\?: string \}>/);
  assert.match(page, /InstagramOAuthFeedback/);
  assert.match(feedback, /resolveInstagramOAuthFeedback/);
  assert.match(feedback, /role="status"/);
  assert.match(messages, /Instagram conectado com sucesso/);
  assert.match(messages, /Não foi possível concluir a conexão com o Instagram/);

  assert.match(metaApi, /graph\.instagram\.com/);
  assert.match(metaApi, /me\?fields=user_id,username/);
  assert.doesNotMatch(metaApi, /graph\.facebook\.com/);
  assert.equal((metaApi.match(/requireInstagramRedirectUri\(\)/g) ?? []).length, 2);
  assert.match(metaApi, /logInstagramRedirectUri\("oauth_authorize"/);
  assert.match(metaApi, /logInstagramRedirectUri\("oauth_token_exchange"/);
  assert.doesNotMatch(metaApi, /process\.env\.META_INSTAGRAM_REDIRECT_URI/);
});

test("redirect URI e normalizada por trim e compartilhada entre authorize e exchange", () => {
  const dirty = "  https://www.militrin.com.br/api/instagram/oauth/callback\r\n";
  assert.equal(readInstagramRedirectUri({ META_INSTAGRAM_REDIRECT_URI: dirty }), CANONICAL_INSTAGRAM_OAUTH_REDIRECT_URI);
  assert.equal(requireInstagramRedirectUri({ META_INSTAGRAM_REDIRECT_URI: dirty }), CANONICAL_INSTAGRAM_OAUTH_REDIRECT_URI);
  const inspection = inspectInstagramRedirectUri(dirty);
  assert.equal(inspection.hasLeadingWhitespace, true);
  assert.equal(inspection.hasTrailingWhitespace, true);
  assert.equal(inspection.hasCrLf, true);
  assert.equal(inspection.exactCanonical, false);
  assert.equal(inspection.hasTrailingSlash, false);

  const withSlash = `${CANONICAL_INSTAGRAM_OAUTH_REDIRECT_URI}/`;
  assert.equal(readInstagramRedirectUri({ META_INSTAGRAM_REDIRECT_URI: withSlash }), withSlash);
  assert.notEqual(readInstagramRedirectUri({ META_INSTAGRAM_REDIRECT_URI: withSlash }), CANONICAL_INSTAGRAM_OAUTH_REDIRECT_URI);
  assert.equal(inspectInstagramRedirectUri(withSlash).hasTrailingSlash, true);
  assert.equal(inspectInstagramRedirectUri(CANONICAL_INSTAGRAM_OAUTH_REDIRECT_URI).exactCanonical, true);

  const authorizeUri = requireInstagramRedirectUri({ META_INSTAGRAM_REDIRECT_URI: dirty });
  const exchangeUri = requireInstagramRedirectUri({ META_INSTAGRAM_REDIRECT_URI: dirty });
  assert.equal(authorizeUri, exchangeUri);
  assert.deepEqual(instagramRedirectUriDiagnostics(authorizeUri), instagramRedirectUriDiagnostics(exchangeUri));
  assert.equal(instagramRedirectUriDiagnostics(authorizeUri).redirect_uri_length, CANONICAL_INSTAGRAM_OAUTH_REDIRECT_URI.length);
});
