import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { exchangeInstagramCode } from "@/lib/instagram/meta-api";
import { encryptInstagramToken } from "@/lib/instagram/crypto";
import { appBaseUrl } from "@/lib/urls/app-base-url";

export async function GET(request: NextRequest) {
  const destination = new URL("/sorteios", appBaseUrl());
  try {
    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const stored = request.cookies.get("instagram_oauth_state")?.value;
    const [expectedState, organizationId] = stored?.split(".") ?? [];
    if (!code || !state || !expectedState || state !== expectedState || !organizationId) throw new Error("Estado OAuth invalido ou expirado.");
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error("Sessao administrativa expirada.");
    const { data: allowed } = await supabase.rpc("user_can_access_organization", { p_user_id: user.id, p_organization_id: organizationId });
    if (!allowed) throw new Error("Sem acesso a organizacao selecionada.");
    const token = await exchangeInstagramCode(code);
    const expiresAt = token.expiresIn ? new Date(Date.now() + token.expiresIn * 1000).toISOString() : null;
    const { error } = await createServiceRoleSupabaseClient().rpc("connect_instagram_integration", { p_organization_id: organizationId, p_instagram_user_id: token.profile.id, p_instagram_username: token.profile.username, p_encrypted_access_token: encryptInstagramToken(token.accessToken), p_token_expires_at: expiresAt, p_actor_user_id: user.id });
    if (error) throw new Error(error.message);
    destination.searchParams.set("instagram", "connected");
  } catch (error) {
    destination.searchParams.set("instagram", "error");
    destination.searchParams.set("message", error instanceof Error && error.message.startsWith("Nao foi possivel") ? error.message : "Nao foi possivel conectar o Instagram. Confira a configuracao do app e tente novamente.");
  }
  const response = NextResponse.redirect(destination);
  response.cookies.delete("instagram_oauth_state");
  return response;
}
