import "server-only";
import { decryptInstagramToken, encryptInstagramToken } from "@/lib/instagram/crypto";
import { refreshInstagramAccessToken } from "@/lib/instagram/meta-api";
import { logInstagramGraphEvent } from "@/lib/instagram/meta-error";
import { requireGiveawayAdminContext } from "@/lib/giveaways/admin-context";

async function loadConnectedInstagramRow() {
  const ctx = await requireGiveawayAdminContext();
  const { data, error } = await ctx.admin
    .from("instagram_integrations")
    .select("id,instagram_user_id,instagram_username,encrypted_access_token,token_expires_at")
    .eq("organization_id", ctx.organization.id)
    .is("disconnected_at", null)
    .maybeSingle();
  if (error) throw new Error("Nao foi possivel consultar a conexao do Instagram.");
  if (!data) throw new Error("Conecte uma conta profissional do Instagram primeiro.");
  if (!data.encrypted_access_token) throw new Error("A conexao com o Instagram foi desativada. Conecte a conta novamente.");
  return { ctx, data, token: decryptInstagramToken(String(data.encrypted_access_token)) };
}

export async function requireConnectedInstagramIntegration() {
  const { ctx, data, token: initialToken } = await loadConnectedInstagramRow();
  let token = initialToken;
  const expiresAt = data.token_expires_at ? new Date(String(data.token_expires_at)).getTime() : 0;
  if (expiresAt && expiresAt - Date.now() < 7 * 24 * 60 * 60 * 1000) {
    try {
      const refreshed = await refreshInstagramAccessToken(token);
      token = refreshed.accessToken;
      const nextExpiry = refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString() : null;
      const { error: refreshError } = await ctx.admin.from("instagram_integrations").update({
        encrypted_access_token: encryptInstagramToken(token),
        token_expires_at: nextExpiry,
        updated_at: new Date().toISOString(),
      }).eq("id", data.id);
      if (refreshError) {
        logInstagramGraphEvent({
          event: "token_refresh_persist_failed",
          operation: "token_refresh",
          endpoint: "refresh_access_token",
          integrationId: data.id,
        });
      }
    } catch {
      logInstagramGraphEvent({
        event: "token_refresh_skipped",
        operation: "token_refresh",
        endpoint: "refresh_access_token",
        integrationId: data.id,
        reason: "refresh_failed_keep_current_token",
      });
    }
  }
  return {
    ...ctx,
    integrationId: String(data.id),
    userId: String(data.instagram_user_id),
    username: String(data.instagram_username),
    token,
  };
}
