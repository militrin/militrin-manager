import "server-only";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import type { InstagramOAuthStore } from "@/lib/instagram/oauth-store";

export function createSupabaseInstagramOAuthStore(): InstagramOAuthStore {
  const admin = createServiceRoleSupabaseClient();

  return {
    async createContext(input) {
      await admin.from("instagram_oauth_states").delete().lt("expires_at", new Date().toISOString());
      const { error } = await admin.from("instagram_oauth_states").insert({
        state: input.state,
        admin_user_id: input.adminUserId,
        organization_id: input.organizationId,
        expires_at: input.expiresAt.toISOString(),
      });
      if (error) throw new Error("Nao foi possivel iniciar a conexao com o Instagram.");
    },

    async consumeContext(state, _now) {
      const { data, error } = await admin.rpc("consume_instagram_oauth_state", { p_state: state });
      if (error) throw new Error("Nao foi possivel validar o estado OAuth do Instagram.");
      const row = (Array.isArray(data) ? data[0] : data) as { admin_user_id?: string; organization_id?: string } | null;
      if (!row?.admin_user_id || !row.organization_id) return null;
      return { adminUserId: String(row.admin_user_id), organizationId: String(row.organization_id) };
    },

    async userCanAccessOrganization(userId, organizationId) {
      const { data, error } = await admin.rpc("user_can_access_organization", {
        p_user_id: userId,
        p_organization_id: organizationId,
      });
      if (error) return false;
      return data === true;
    },

    async connectIntegration(input) {
      const { error } = await admin.rpc("connect_instagram_integration", {
        p_organization_id: input.organizationId,
        p_instagram_user_id: input.instagramUserId,
        p_instagram_username: input.instagramUsername,
        p_encrypted_access_token: input.encryptedAccessToken,
        p_token_expires_at: input.tokenExpiresAt,
        p_actor_user_id: input.actorUserId,
      });
      if (error) throw new Error("Nao foi possivel salvar a integracao do Instagram.");
      const { error: auditError } = await admin.from("audit_logs").insert({
        action: "INSTAGRAM_CONNECTED",
        entity_type: "instagram_integration",
        details: {
          organization_id: input.organizationId,
          instagram_username: input.instagramUsername,
          actor_user_id: input.actorUserId,
        },
      });
      void auditError;
    },
  };
}
