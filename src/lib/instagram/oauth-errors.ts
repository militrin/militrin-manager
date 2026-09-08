export const INSTAGRAM_OAUTH_REASONS = ["state", "session", "token", "profile", "storage", "unknown"] as const;
export type InstagramOAuthReason = (typeof INSTAGRAM_OAUTH_REASONS)[number];

export const INSTAGRAM_OAUTH_STAGES = [
  "oauth_callback_received",
  "oauth_state_invalid",
  "oauth_context_missing",
  "oauth_code_missing",
  "oauth_token_exchange_failed",
  "oauth_profile_fetch_failed",
  "oauth_encrypt_failed",
  "oauth_db_upsert_failed",
  "oauth_connected",
] as const;
export type InstagramOAuthStage = (typeof INSTAGRAM_OAUTH_STAGES)[number];

export type InstagramOAuthMetaDetails = {
  httpStatus?: number;
  errorCode?: string | number;
  errorType?: string;
  sanitizedMessage?: string;
};

export class InstagramOAuthError extends Error {
  readonly stage: InstagramOAuthStage;
  readonly reason: InstagramOAuthReason;
  readonly meta?: InstagramOAuthMetaDetails;

  constructor(
    stage: InstagramOAuthStage,
    reason: InstagramOAuthReason,
    message: string,
    meta?: InstagramOAuthMetaDetails,
  ) {
    super(message);
    this.name = "InstagramOAuthError";
    this.stage = stage;
    this.reason = reason;
    this.meta = meta;
  }
}

export function isInstagramOAuthReason(value: string | null | undefined): value is InstagramOAuthReason {
  return Boolean(value && (INSTAGRAM_OAUTH_REASONS as readonly string[]).includes(value));
}
