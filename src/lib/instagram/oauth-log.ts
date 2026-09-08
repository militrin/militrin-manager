import type { InstagramOAuthMetaDetails, InstagramOAuthStage } from "./oauth-errors.ts";

const FORBIDDEN_KEYS = new Set([
  "access_token",
  "refresh_token",
  "token",
  "code",
  "client_secret",
  "app_secret",
  "encryption_key",
  "signed_request",
  "encrypted_access_token",
]);

export function logInstagramOAuthStage(stage: InstagramOAuthStage, meta?: InstagramOAuthMetaDetails) {
  const payload: Record<string, unknown> = { event: stage };
  if (meta?.httpStatus != null) payload.httpStatus = meta.httpStatus;
  if (meta?.errorCode != null) payload.errorCode = meta.errorCode;
  if (meta?.errorType) payload.errorType = meta.errorType;
  if (meta?.sanitizedMessage) payload.sanitizedMessage = meta.sanitizedMessage;
  for (const key of Object.keys(payload)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) delete payload[key];
  }
  console.info("[instagram-oauth]", JSON.stringify(payload));
}
