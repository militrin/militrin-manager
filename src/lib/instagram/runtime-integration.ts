import "server-only";
import { decryptInstagramToken, encryptInstagramToken } from "@/lib/instagram/crypto";
import { refreshInstagramAccessToken } from "@/lib/instagram/meta-api";
import { requireGiveawayAdminContext } from "@/lib/giveaways/admin-context";

export async function requireConnectedInstagramIntegration() {
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
  let token = decryptInstagramToken(String(data.encrypted_access_token));
  const expiresAt = data.token_expires_at ? new Date(String(data.token_expires_at)).getTime() : 0;
  if (expiresAt && expiresAt - Date.now() < 7 * 24 * 60 * 60 * 1000) {
    const refreshed = await refreshInstagramAccessToken(token);
    token = refreshed.accessToken;
    const nextExpiry = refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString() : null;
    const { error: refreshError } = await ctx.admin.from("instagram_integrations").update({
      encrypted_access_token: encryptInstagramToken(token),
      token_expires_at: nextExpiry,
      updated_at: new Date().toISOString(),
    }).eq("id", data.id);
    if (refreshError) throw new Error("O token foi renovado, mas nao foi possivel salvar a nova credencial com seguranca.");
  }
  return {
    ...ctx,
    integrationId: String(data.id),
    userId: String(data.instagram_user_id),
    username: String(data.instagram_username),
    token,
  };
}
