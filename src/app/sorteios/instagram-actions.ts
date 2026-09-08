"use server";

import "server-only";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { requireGiveawayAdminContext } from "@/lib/giveaways/admin-context";
import { decryptInstagramToken, encryptInstagramToken } from "@/lib/instagram/crypto";
import { INSTAGRAM_OAUTH_STATE_COOKIE, INSTAGRAM_OAUTH_STATE_MAX_AGE_SECONDS, instagramOAuthStateCookieOptions } from "@/lib/instagram/oauth-cookie";
import { isInstagramRuntimeConfigured } from "@/lib/instagram/oauth-config";
import { createSupabaseInstagramOAuthStore } from "@/lib/instagram/oauth-store-supabase";
import { instagramAuthorizeUrl, refreshInstagramAccessToken } from "@/lib/instagram/meta-api";
import { isMissingGiveawaySchemaError } from "@/lib/instagram/database-readiness";

export type InstagramIntegrationStatus = {
  state: "available" | "not_configured" | "database_not_ready";
  connected: boolean;
  username?: string;
  expiresAt?: string | null;
};

export async function getInstagramStatus(): Promise<InstagramIntegrationStatus> {
  const { organization, admin } = await requireGiveawayAdminContext();
  const { data, error } = await admin.from("instagram_integrations").select("id,instagram_username,token_expires_at,connected_at").eq("organization_id", organization.id).is("disconnected_at", null).maybeSingle();
  if (error) {
    if (isMissingGiveawaySchemaError(error)) return { state: "database_not_ready", connected: false };
    throw new Error("Nao foi possivel consultar o status da integracao Instagram.");
  }
  if (!isInstagramRuntimeConfigured()) {
    return { state: "not_configured", connected: false };
  }
  return data ? { state: "available", connected: true, username: String(data.instagram_username), expiresAt: data.token_expires_at as string | null } : { state: "available", connected: false };
}

export async function disconnectInstagram() {
  const { user, organization, admin } = await requireGiveawayAdminContext();
  const { error } = await admin.from("instagram_integrations").update({ encrypted_access_token: null, disconnected_at: new Date().toISOString(), disconnected_by: user.id, updated_at: new Date().toISOString() }).eq("organization_id", organization.id).is("disconnected_at", null);
  if (error) throw new Error("Nao foi possivel desconectar o Instagram.");
  return { disconnected: true as const };
}

export async function beginInstagramOAuth() {
  const { user, organization } = await requireGiveawayAdminContext();
  if (!isInstagramRuntimeConfigured()) throw new Error("Credenciais da integracao Instagram ainda nao configuradas.");
  const state = randomBytes(32).toString("base64url");
  await createSupabaseInstagramOAuthStore().createContext({
    state,
    adminUserId: user.id,
    organizationId: organization.id,
    expiresAt: new Date(Date.now() + INSTAGRAM_OAUTH_STATE_MAX_AGE_SECONDS * 1000),
  });
  (await cookies()).set(INSTAGRAM_OAUTH_STATE_COOKIE, state, instagramOAuthStateCookieOptions());
  return { url: instagramAuthorizeUrl(state) };
}

export async function refreshConnectedInstagramTokenIfNeeded() {
  const { organization, admin } = await requireGiveawayAdminContext();
  const { data, error } = await admin.from("instagram_integrations").select("id,encrypted_access_token,token_expires_at").eq("organization_id", organization.id).is("disconnected_at", null).maybeSingle();
  if (error || !data?.encrypted_access_token) return;
  const expiresAt = data.token_expires_at ? new Date(String(data.token_expires_at)).getTime() : 0;
  if (!expiresAt || expiresAt - Date.now() >= 7 * 24 * 60 * 60 * 1000) return;
  const refreshed = await refreshInstagramAccessToken(decryptInstagramToken(String(data.encrypted_access_token)));
  await admin.from("instagram_integrations").update({
    encrypted_access_token: encryptInstagramToken(refreshed.accessToken),
    token_expires_at: refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq("id", data.id);
}
