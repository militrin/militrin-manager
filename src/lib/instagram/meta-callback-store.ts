import "server-only";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { InstagramDataDeletionPublicStatus, MetaCallbackStore } from "@/lib/instagram/meta-callbacks";

function asCount(value: unknown) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

export function createSupabaseMetaCallbackStore(): MetaCallbackStore {
  const admin = createServiceRoleSupabaseClient();

  return {
    async deauthorize(instagramUserId) {
      const { data, error } = await admin.rpc("handle_instagram_deauthorize", {
        p_instagram_user_id: instagramUserId,
      });
      if (error) throw new Error("Nao foi possivel processar a desautorizacao do Instagram.");
      const row = (Array.isArray(data) ? data[0] : data) as { disconnected_now?: number; already_disconnected?: number } | null;
      return {
        disconnectedNow: asCount(row?.disconnected_now),
        alreadyDisconnected: asCount(row?.already_disconnected),
      };
    },

    async requestDataDeletion(instagramUserId, confirmationCode) {
      const { data, error } = await admin.rpc("handle_instagram_data_deletion", {
        p_instagram_user_id: instagramUserId,
        p_confirmation_code: confirmationCode,
      });
      if (error) throw new Error("Nao foi possivel registrar a exclusao de dados do Instagram.");
      const row = (Array.isArray(data) ? data[0] : data) as { confirmation_code?: string; reused?: boolean } | null;
      const code = typeof row?.confirmation_code === "string" ? row.confirmation_code : "";
      if (!code) throw new Error("Nao foi possivel emitir o codigo de confirmacao.");
      return { confirmationCode: code, reused: Boolean(row?.reused) };
    },

    async getPublicStatus(confirmationCode) {
      const { data, error } = await admin.rpc("get_instagram_data_deletion_public_status", {
        p_confirmation_code: confirmationCode,
      });
      if (error) throw new Error("Nao foi possivel consultar o status da solicitacao.");
      const row = (Array.isArray(data) ? data[0] : data) as { status?: string; created_at?: string } | null;
      if (!row?.status || !row.created_at) return null;
      if (row.status !== "received" && row.status !== "credentials_revoked") return null;
      return { status: row.status, createdAt: String(row.created_at) };
    },
  };
}

export async function loadInstagramDataDeletionPublicStatus(
  confirmationCode: string,
): Promise<InstagramDataDeletionPublicStatus | null> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_instagram_data_deletion_public_status", {
    p_confirmation_code: confirmationCode,
  });
  if (error || !data) return null;
  const row = (Array.isArray(data) ? data[0] : data) as { status?: string; created_at?: string } | null;
  if (!row?.status || !row.created_at) return null;
  if (row.status !== "received" && row.status !== "credentials_revoked") return null;
  return { status: row.status, createdAt: String(row.created_at) };
}
