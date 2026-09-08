import { NextResponse, type NextRequest } from "next/server";
import { exchangeInstagramCode } from "@/lib/instagram/meta-api";
import { encryptInstagramToken } from "@/lib/instagram/crypto";
import { processInstagramOAuthCallback } from "@/lib/instagram/oauth-callback";
import { INSTAGRAM_OAUTH_STATE_COOKIE, instagramOAuthStateCookieOptions } from "@/lib/instagram/oauth-cookie";
import { instagramOAuthRedirectSearch } from "@/lib/instagram/oauth-feedback";
import { createSupabaseInstagramOAuthStore } from "@/lib/instagram/oauth-store-supabase";
import { appBaseUrl } from "@/lib/urls/app-base-url";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const result = await processInstagramOAuthCallback(
    {
      code: request.nextUrl.searchParams.get("code"),
      state: request.nextUrl.searchParams.get("state"),
      cookieState: request.cookies.get(INSTAGRAM_OAUTH_STATE_COOKIE)?.value ?? null,
    },
    {
      store: createSupabaseInstagramOAuthStore(),
      exchangeCode: exchangeInstagramCode,
      encryptToken: encryptInstagramToken,
    },
  );
  const destination = new URL("/sorteios", appBaseUrl());
  destination.search = instagramOAuthRedirectSearch(result);
  const response = NextResponse.redirect(destination);
  response.cookies.set(INSTAGRAM_OAUTH_STATE_COOKIE, "", instagramOAuthStateCookieOptions(0));
  return response;
}
