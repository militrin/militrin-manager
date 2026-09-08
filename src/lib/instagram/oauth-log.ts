import { createHash } from "node:crypto";
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

export function instagramRedirectUriDiagnostics(redirectUri: string) {
  return {
    redirect_uri_length: redirectUri.length,
    redirect_uri_hash: createHash("sha256").update(redirectUri, "utf8").digest("hex"),
  };
}

export function logInstagramRedirectUri(stage: "oauth_authorize" | "oauth_token_exchange", redirectUri: string) {
  console.info("[instagram-oauth]", JSON.stringify({
    event: stage,
    ...instagramRedirectUriDiagnostics(redirectUri),
  }));
}

export function logInstagramOAuthCodeInspect(inspect: {
  rawPresent: boolean;
  rawEncodedLength: number | null;
  rawEncodedHash: string | null;
  rawHasLiteralPlus: boolean;
  rawHasPct2b: boolean;
  rawHasPct20: boolean;
  parsedPresent: boolean;
  parsedLength: number | null;
  parsedHash: string | null;
  parsedHasSpace: boolean;
  parsedHasPlus: boolean;
  plusPreservingLength: number | null;
  plusPreservingHash: string | null;
  plusPreservingParsedMatch: boolean | null;
}) {
  console.info("[instagram-oauth]", JSON.stringify({
    event: "oauth_code_inspect",
    raw_present: inspect.rawPresent,
    raw_encoded_length: inspect.rawEncodedLength,
    raw_encoded_hash: inspect.rawEncodedHash,
    raw_has_literal_plus: inspect.rawHasLiteralPlus,
    raw_has_pct2b: inspect.rawHasPct2b,
    raw_has_pct20: inspect.rawHasPct20,
    parsed_length: inspect.parsedLength,
    parsed_hash: inspect.parsedHash,
    parsed_has_space: inspect.parsedHasSpace,
    parsed_has_plus: inspect.parsedHasPlus,
    plus_preserving_length: inspect.plusPreservingLength,
    plus_preserving_hash: inspect.plusPreservingHash,
    plus_preserving_parsed_match: inspect.plusPreservingParsedMatch,
  }));
}

export function logInstagramOAuthCodeTrim(inspect: {
  parsedLength: number;
  parsedHash: string;
  trimmedLength: number;
  trimmedHash: string;
  trimChanged: boolean;
  sentLength: number;
  sentHash: string;
  sentMatchesParsed: boolean;
}) {
  console.info("[instagram-oauth]", JSON.stringify({
    event: "oauth_code_trim",
    parsed_length: inspect.parsedLength,
    parsed_hash: inspect.parsedHash,
    trimmed_length: inspect.trimmedLength,
    trimmed_hash: inspect.trimmedHash,
    trim_changed: inspect.trimChanged,
    sent_length: inspect.sentLength,
    sent_hash: inspect.sentHash,
    sent_matches_parsed: inspect.sentMatchesParsed,
  }));
}

export function logInstagramOAuthTokenRequest(input: {
  clientIdLast4: string;
  clientSecretLength: number;
  clientSecretHashPrefix: string | null;
  redirectUriLength: number;
  redirectUriHash: string;
  codeLength: number;
  codeHash: string;
  grantType: string;
}) {
  console.info("[instagram-oauth]", JSON.stringify({
    event: "oauth_token_request",
    multipart: true,
    client_id_last4: input.clientIdLast4,
    client_secret_length: input.clientSecretLength,
    client_secret_hash_prefix: input.clientSecretHashPrefix,
    redirect_uri_length: input.redirectUriLength,
    redirect_uri_hash: input.redirectUriHash,
    code_length: input.codeLength,
    code_hash: input.codeHash,
    grant_type: input.grantType,
  }));
}

export function logInstagramAppSecretInspect(inspect: {
  present: boolean;
  length: number;
  hasLeadingWhitespace: boolean;
  hasTrailingWhitespace: boolean;
  hasCrLf: boolean;
  sha256: string | null;
}) {
  console.info("[instagram-oauth]", JSON.stringify({
    event: "oauth_app_secret_inspect",
    present: inspect.present,
    length: inspect.length,
    has_leading_whitespace: inspect.hasLeadingWhitespace,
    has_trailing_whitespace: inspect.hasTrailingWhitespace,
    has_crlf: inspect.hasCrLf,
    sha256: inspect.sha256,
  }));
}

