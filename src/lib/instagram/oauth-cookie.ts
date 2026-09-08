import { timingSafeEqual } from "node:crypto";

export const INSTAGRAM_OAUTH_STATE_COOKIE = "instagram_oauth_state";
export const INSTAGRAM_OAUTH_STATE_MAX_AGE_SECONDS = 600;
export const INSTAGRAM_OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{32,86}$/;

export function instagramOAuthStateCookieOptions(maxAge = INSTAGRAM_OAUTH_STATE_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

export function isValidInstagramOAuthState(value: string | null | undefined): value is string {
  return typeof value === "string" && INSTAGRAM_OAUTH_STATE_PATTERN.test(value);
}

export function oauthStatesMatch(actual: string, expected: string) {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}
