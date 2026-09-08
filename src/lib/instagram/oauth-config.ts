export const REQUIRED_META_GRAPH_API_VERSION = "v26.0";
export const INSTAGRAM_TOKEN_ENCRYPTION_KEY_MIN_LENGTH = 32;

export type InstagramRuntimeConfigCheck = {
  configured: boolean;
  appId: boolean;
  appSecret: boolean;
  redirectUri: boolean;
  graphApiVersion: boolean;
  encryptionKey: boolean;
};

function present(value: string | undefined) {
  return Boolean(value?.trim());
}

export function inspectInstagramRuntimeConfig(env: NodeJS.ProcessEnv = process.env): InstagramRuntimeConfigCheck {
  const graphVersion = env.META_GRAPH_API_VERSION?.trim() === REQUIRED_META_GRAPH_API_VERSION;
  const encryptionKey = (env.INSTAGRAM_TOKEN_ENCRYPTION_KEY?.length ?? 0) >= INSTAGRAM_TOKEN_ENCRYPTION_KEY_MIN_LENGTH;
  const appId = present(env.META_INSTAGRAM_APP_ID);
  const appSecret = present(env.META_INSTAGRAM_APP_SECRET);
  const redirectUri = present(env.META_INSTAGRAM_REDIRECT_URI);
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
