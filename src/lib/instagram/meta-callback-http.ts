import { NextResponse } from "next/server";
import { appBaseUrl } from "@/lib/urls/app-base-url";
import { processInstagramMetaCallbackPost, type MetaCallbackStore } from "@/lib/instagram/meta-callbacks";

export async function respondToInstagramMetaCallback(
  request: Request,
  input: {
    appSecret: string | undefined;
    store: MetaCallbackStore;
    kind: "deauthorize" | "data-deletion";
  },
) {
  const result = await processInstagramMetaCallbackPost(
    await request.text(),
    request.headers.get("content-type"),
    { ...input, baseUrl: appBaseUrl() },
  );
  if (result.body === null) return new NextResponse(null, { status: result.status });
  return NextResponse.json(result.body, { status: result.status });
}
