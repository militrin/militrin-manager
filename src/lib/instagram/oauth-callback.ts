import { InstagramOAuthError, type InstagramOAuthReason } from "./oauth-errors.ts";
import { logInstagramOAuthStage } from "./oauth-log.ts";
import { isInstagramRuntimeConfigured } from "./oauth-config.ts";
import { isValidInstagramOAuthState, oauthStatesMatch } from "./oauth-cookie.ts";
import type { ExchangedInstagramToken, InstagramOAuthStore } from "./oauth-store.ts";

export type InstagramOAuthCallbackInput = {
  code: string | null;
  state: string | null;
  cookieState: string | null;
};

export type InstagramOAuthCallbackDeps = {
  now?: () => Date;
  store: InstagramOAuthStore;
  exchangeCode: (code: string) => Promise<ExchangedInstagramToken>;
  encryptToken: (accessToken: string) => string;
  isConfigured?: () => boolean;
  log?: typeof logInstagramOAuthStage;
};

export type InstagramOAuthCallbackResult =
  | { instagram: "connected" }
  | { instagram: "error"; reason: InstagramOAuthReason };

function fail(
  log: typeof logInstagramOAuthStage,
  error: InstagramOAuthError,
): InstagramOAuthCallbackResult {
  log(error.stage, error.meta);
  return { instagram: "error", reason: error.reason };
}

export async function processInstagramOAuthCallback(
  input: InstagramOAuthCallbackInput,
  deps: InstagramOAuthCallbackDeps,
): Promise<InstagramOAuthCallbackResult> {
  const log = deps.log ?? logInstagramOAuthStage;
  const configured = deps.isConfigured ?? isInstagramRuntimeConfigured;
  log("oauth_callback_received");

  try {
    if (!isValidInstagramOAuthState(input.state)) {
      throw new InstagramOAuthError("oauth_state_invalid", "state", "Estado OAuth invalido ou expirado.");
    }
    if (input.cookieState != null && input.cookieState !== "" && !oauthStatesMatch(input.cookieState, input.state)) {
      throw new InstagramOAuthError("oauth_state_invalid", "state", "Estado OAuth invalido ou expirado.");
    }

    let context;
    try {
      context = await deps.store.consumeContext(input.state, deps.now?.() ?? new Date());
    } catch {
      throw new InstagramOAuthError("oauth_context_missing", "session", "Contexto OAuth ausente ou expirado.");
    }
    if (!context) {
      throw new InstagramOAuthError("oauth_context_missing", "session", "Contexto OAuth ausente ou expirado.");
    }
    const allowed = await deps.store.userCanAccessOrganization(context.adminUserId, context.organizationId);
    if (!allowed) {
      throw new InstagramOAuthError("oauth_context_missing", "session", "Contexto OAuth ausente ou expirado.");
    }

    const code = input.code?.trim() ?? "";
    if (!code) {
      throw new InstagramOAuthError("oauth_code_missing", "token", "Codigo OAuth ausente.");
    }

    if (!configured()) {
      throw new InstagramOAuthError("oauth_context_missing", "unknown", "Integracao Instagram nao configurada.");
    }

    let exchanged: ExchangedInstagramToken;
    try {
      exchanged = await deps.exchangeCode(code);
    } catch (error) {
      if (error instanceof InstagramOAuthError) throw error;
      throw new InstagramOAuthError("oauth_token_exchange_failed", "token", "Falha na troca do codigo OAuth.");
    }

    let encrypted: string;
    try {
      encrypted = deps.encryptToken(exchanged.accessToken);
    } catch {
      throw new InstagramOAuthError("oauth_encrypt_failed", "storage", "Falha ao cifrar o token do Instagram.");
    }
    if (!encrypted) {
      throw new InstagramOAuthError("oauth_encrypt_failed", "storage", "Falha ao cifrar o token do Instagram.");
    }

    const expiresAt = exchanged.expiresIn ? new Date(Date.now() + exchanged.expiresIn * 1000).toISOString() : null;
    try {
      await deps.store.connectIntegration({
        organizationId: context.organizationId,
        instagramUserId: exchanged.profile.id,
        instagramUsername: exchanged.profile.username,
        encryptedAccessToken: encrypted,
        tokenExpiresAt: expiresAt,
        actorUserId: context.adminUserId,
      });
    } catch {
      throw new InstagramOAuthError("oauth_db_upsert_failed", "storage", "Falha ao persistir a integracao do Instagram.");
    }

    log("oauth_connected");
    return { instagram: "connected" };
  } catch (error) {
    if (error instanceof InstagramOAuthError) return fail(log, error);
    return fail(log, new InstagramOAuthError("oauth_db_upsert_failed", "unknown", "Falha inesperada no OAuth do Instagram."));
  }
}
