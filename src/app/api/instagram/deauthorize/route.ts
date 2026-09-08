import { respondToInstagramMetaCallback } from "@/lib/instagram/meta-callback-http";
import { createSupabaseMetaCallbackStore } from "@/lib/instagram/meta-callback-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return respondToInstagramMetaCallback(request, {
    appSecret: process.env.META_INSTAGRAM_APP_SECRET,
    store: createSupabaseMetaCallbackStore(),
    kind: "deauthorize",
  });
}
