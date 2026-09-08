export const REQUIRED_META_GRAPH_API_VERSION = "v26.0";
export const INSTAGRAM_TOKEN_ENCRYPTION_KEY_MIN_LENGTH = 32;
export const CANONICAL_INSTAGRAM_OAUTH_REDIRECT_URI = "https://www.militrin.com.br/api/instagram/oauth/callback";

export type InstagramRuntimeConfigCheck = {
  configured: boolean;
  appId: boolean;
  appSecret: boolean;
  redirectUri: boolean;
  graphApiVersion: boolean;
  encryptionKey: boolean;
};

export type InstagramRedirectUriInspection = {
  present: boolean;
  length: number;
  hasLeadingWhitespace: boolean;
  hasTrailingWhitespace: boolean;
  hasCrLf: boolean;
  hasTrailingSlash: boolean;
  exactCanonical: boolean;
  value: string | null;
};

function present(value: string | undefined) {
  return Boolean(value?.trim());
}

export function inspectInstagramRedirectUri(raw: string | undefined): InstagramRedirectUriInspection {
  const value = raw ?? "";
  const trimmed = value.trim();
  return {
    present: Boolean(trimmed),
    length: value.length,
    hasLeadingWhitespace: value !== value.trimStart(),
    hasTrailingWhitespace: value !== value.trimEnd(),
    hasCrLf: /[\r\n]/.test(value),
    hasTrailingSlash: trimmed.endsWith("/"),
    exactCanonical: value === CANONICAL_INSTAGRAM_OAUTH_REDIRECT_URI,
    value: trimmed || null,
  };
}

export function readInstagramRedirectUri(env: NodeJS.ProcessEnv = process.env): string | null {
  const trimmed = env.META_INSTAGRAM_REDIRECT_URI?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

export function requireInstagramRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  const redirectUri = readInstagramRedirectUri(env);
  if (!redirectUri) throw new Error("META_INSTAGRAM_REDIRECT_URI deve ser uma URL HTTPS valida.");
  return redirectUri;
}

export function inspectInstagramRuntimeConfig(env: NodeJS.ProcessEnv = process.env): InstagramRuntimeConfigCheck {
  const graphVersion = env.META_GRAPH_API_VERSION?.trim() === REQUIRED_META_GRAPH_API_VERSION;
  const encryptionKey = (env.INSTAGRAM_TOKEN_ENCRYPTION_KEY?.length ?? 0) >= INSTAGRAM_TOKEN_ENCRYPTION_KEY_MIN_LENGTH;
  const appId = present(env.META_INSTAGRAM_APP_ID);
  const appSecret = present(env.META_INSTAGRAM_APP_SECRET);
  const redirectUri = Boolean(readInstagramRedirectUri(env));
  return {
    appId,
    appSecret,
    redirectUri,
    graphApiVersion: graphVersion,
    encryptionKey,
    configured: appId && appSecret && redirectUri && graphVersion && encryptionKey,
  };
}

export function isInstagramRuntimeConfigured(env: NodeJS.ProcessEnv = process.env) {
  return inspectInstagramRuntimeConfig(env).configured;
}
