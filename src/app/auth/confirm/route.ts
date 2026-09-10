import { NextResponse, type NextRequest } from "next/server";

const noStoreHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
};

// GET /auth/confirm NÃO consome o OTP. Prefetch/scanner que abrir este URL
// só é redirecionado à página intermediária; o token só é usado no POST
// explícito de /auth/confirmar.
export async function GET(request: NextRequest) {
  const url = new URL("/auth/confirmar", request.url);
  request.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });
  return NextResponse.redirect(url, { headers: noStoreHeaders });
}
