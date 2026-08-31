"use server";

import "server-only";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { requireAdministrativePanelAccess } from "@/lib/admin/panel-access";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { decryptInstagramToken, encryptInstagramToken } from "@/lib/instagram/crypto";
import { instagramAuthorizeUrl, listInstagramComments, listInstagramMedia, refreshInstagramAccessToken } from "@/lib/instagram/meta-api";
import type { ParticipationEntry, SorteioSession } from "@/components/sorteios/types";
import { assertFrozenSnapshotInvariant, assertUniqueCommentIds, normalizeUniqueInstagramComments, resolveOwnedInstagramMedia } from "@/lib/instagram/normalize";

const sessionSchema = z.object({
  databaseId: z.string().uuid().nullable(), id: z.string().min(1).max(80),
  createdAt: z.string(), importedFileName: z.string().max(255).nullable(), importedAt: z.string().nullable(),
  entries: z.array(z.object({
    entryNumber: z.number().int().positive(), commentId: z.string().min(1).max(255), username: z.string().min(1).max(255),
    comment: z.string().max(10000), mentionsCount: z.number().int().nonnegative().nullable(), mentions: z.string().max(5000),
    commentUrl: z.string().max(2000), commentCreatedAt: z.string().nullable(), chance: z.string().max(255), status: z.enum(["active", "disqualified"]),
  })).max(100000),
  status: z.enum(["empty", "ready", "drawing", "awaiting_validation", "finalized"]),
  currentWinnerCommentId: z.string().nullable(), currentDrawAt: z.string().nullable(),
  currentChecklist: z.object({ follows: z.boolean(), liked: z.boolean(), taggedFriends: z.boolean(), sharedStory: z.boolean() }),
  disqualifications: z.array(z.unknown()), confirmedWinner: z.object({ commentId: z.string(), confirmedAt: z.string() }).nullable(),
  history: z.array(z.object({ id: z.string(), timestamp: z.string(), type: z.string(), message: z.string(), detail: z.string().optional() })),
  source: z.enum(["csv", "instagram"]), instagramMediaId: z.string().nullable(), instagramMediaPermalink: z.string().nullable(), instagramIntegrationId: z.string().uuid().nullable(), snapshotFrozenAt: z.string().nullable(),
});

async function context() {
  await requireAdministrativePanelAccess();
  const [{ organization }, supabase] = await Promise.all([getCurrentOrganizationContext(), createServerSupabaseClient()]);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !organization) throw new Error("Usuario ou organizacao ativa nao encontrados.");
  return { user, organization, admin: createServiceRoleSupabaseClient() };
}

export async function getInstagramStatus() {
  const { organization, admin } = await context();
  const { data } = await admin.from("instagram_integrations").select("id,instagram_username,token_expires_at,connected_at").eq("organization_id", organization.id).is("disconnected_at", null).maybeSingle();
  return data ? { connected: true as const, username: String(data.instagram_username), expiresAt: data.token_expires_at as string | null } : { connected: false as const };
}

export async function disconnectInstagram() {
  const { user, organization, admin } = await context();
  const { error } = await admin.from("instagram_integrations").update({ encrypted_access_token: null, disconnected_at: new Date().toISOString(), disconnected_by: user.id, updated_at: new Date().toISOString() }).eq("organization_id", organization.id).is("disconnected_at", null);
  if (error) throw new Error("Nao foi possivel desconectar o Instagram.");
  return { disconnected: true as const };
}

export async function beginInstagramOAuth() {
  const { organization } = await context();
  const state = randomBytes(32).toString("base64url");
  (await cookies()).set("instagram_oauth_state", `${state}.${organization.id}`, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/instagram/oauth/callback", maxAge: 600 });
  return { url: instagramAuthorizeUrl(state) };
}

async function integration() {
  const ctx = await context();
  const { data, error } = await ctx.admin.from("instagram_integrations").select("id,instagram_user_id,encrypted_access_token,token_expires_at").eq("organization_id", ctx.organization.id).is("disconnected_at", null).maybeSingle();
  if (error) throw new Error("Nao foi possivel consultar a conexao do Instagram.");
  if (!data) throw new Error("Conecte uma conta profissional do Instagram primeiro.");
  if (!data.encrypted_access_token) throw new Error("A conexao com o Instagram foi desativada. Conecte a conta novamente.");
  let token = decryptInstagramToken(String(data.encrypted_access_token));
  const expiresAt = data.token_expires_at ? new Date(String(data.token_expires_at)).getTime() : 0;
  if (expiresAt && expiresAt - Date.now() < 7 * 24 * 60 * 60 * 1000) {
    const refreshed = await refreshInstagramAccessToken(token);
    token = refreshed.accessToken;
    const nextExpiry = refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString() : null;
    const { error: refreshError } = await ctx.admin.from("instagram_integrations").update({ encrypted_access_token: encryptInstagramToken(token), token_expires_at: nextExpiry, updated_at: new Date().toISOString() }).eq("id", data.id);
    if (refreshError) throw new Error("O token foi renovado, mas nao foi possivel salvar a nova credencial com seguranca.");
  }
  return { ...ctx, integrationId: String(data.id), userId: String(data.instagram_user_id), token };
}

export async function loadInstagramMedia() {
  const value = await integration();
  const media = await listInstagramMedia(value.userId, value.token);
  return media.map((item) => ({ id: item.id, caption: item.caption ?? "", permalink: item.permalink ?? "", timestamp: item.timestamp ?? "", thumbnailUrl: item.thumbnail_url ?? item.media_url ?? "", mediaType: item.media_type ?? "" }));
}

export async function syncInstagramComments(mediaId: string) {
  if (!/^\d+$/.test(mediaId)) throw new Error("ID de midia invalido.");
  const value = await integration();
  const ownedMedia = resolveOwnedInstagramMedia(await listInstagramMedia(value.userId, value.token), mediaId);
  const comments = await listInstagramComments(ownedMedia.id, value.token);
  const entries: ParticipationEntry[] = normalizeUniqueInstagramComments(comments, ownedMedia.permalink!);
  return { entries, mediaId: ownedMedia.id, permalink: ownedMedia.permalink!, integrationId: value.integrationId, syncedAt: new Date().toISOString() };
}

export async function persistGiveawaySession(input: SorteioSession) {
  const parsed = sessionSchema.parse(input) as SorteioSession;
  assertUniqueCommentIds(parsed.entries.map((entry) => entry.commentId));
  if (parsed.currentWinnerCommentId && !parsed.entries.some((entry) => entry.commentId === parsed.currentWinnerCommentId)) throw new Error("O vencedor selecionado nao pertence ao snapshot do sorteio.");
  if (parsed.confirmedWinner && parsed.confirmedWinner.commentId !== parsed.currentWinnerCommentId) throw new Error("O vencedor confirmado nao corresponde ao vencedor selecionado.");
  if (parsed.source === "instagram" && (!parsed.instagramIntegrationId || !parsed.instagramMediaId || !parsed.instagramMediaPermalink)) throw new Error("A origem Instagram esta incompleta.");
  if (parsed.source === "csv" && (parsed.instagramIntegrationId || parsed.instagramMediaId || parsed.instagramMediaPermalink)) throw new Error("Um sorteio CSV nao pode referenciar uma publicacao do Instagram.");
  const { user, organization, admin } = await context();
  const existing = parsed.databaseId ? await admin.from("giveaways").select("snapshot_frozen_at,source,source_file_name,instagram_integration_id,instagram_media_id,instagram_media_permalink").eq("id", parsed.databaseId).eq("organization_id", organization.id).maybeSingle() : null;
  if (existing?.data?.snapshot_frozen_at && parsed.databaseId) {
    const { data: frozenRows, error: frozenError } = await admin.from("giveaway_entries").select("comment_id").eq("giveaway_id", parsed.databaseId);
    if (frozenError) throw new Error(frozenError.message);
    assertFrozenSnapshotInvariant({ source: existing.data.source as "csv" | "instagram", sourceFileName: existing.data.source_file_name as string | null, instagramIntegrationId: existing.data.instagram_integration_id as string | null, instagramMediaId: existing.data.instagram_media_id as string | null, instagramMediaPermalink: existing.data.instagram_media_permalink as string | null, commentIds: (frozenRows ?? []).map((row) => String(row.comment_id)) }, { source: parsed.source, sourceFileName: parsed.importedFileName, instagramIntegrationId: parsed.instagramIntegrationId, instagramMediaId: parsed.instagramMediaId, instagramMediaPermalink: parsed.instagramMediaPermalink, commentIds: parsed.entries.map((entry) => entry.commentId) });
  }
  const frozenAt = (existing?.data?.snapshot_frozen_at as string | null | undefined) ?? parsed.snapshotFrozenAt ?? (parsed.status !== "empty" && parsed.status !== "ready" ? new Date().toISOString() : null);
  const row = {
    organization_id: organization.id, public_id: parsed.id, source: parsed.source, status: parsed.status,
    source_file_name: parsed.importedFileName, instagram_integration_id: parsed.instagramIntegrationId, instagram_media_id: parsed.instagramMediaId, instagram_media_permalink: parsed.instagramMediaPermalink,
    imported_at: parsed.importedAt, synced_at: parsed.source === "instagram" ? parsed.importedAt : null,
    current_winner_comment_id: parsed.currentWinnerCommentId, current_draw_at: parsed.currentDrawAt,
    confirmed_winner_comment_id: parsed.confirmedWinner?.commentId ?? null, confirmed_at: parsed.confirmedWinner?.confirmedAt ?? null,
    state: { currentChecklist: parsed.currentChecklist, disqualifications: parsed.disqualifications }, updated_by: user.id, updated_at: new Date().toISOString(),
  };
  const wasFrozen = Boolean(existing?.data?.snapshot_frozen_at);
  const result = parsed.databaseId
    ? await admin.from("giveaways").update({ ...row, snapshot_frozen_at: wasFrozen ? frozenAt : null }).eq("id", parsed.databaseId).eq("organization_id", organization.id).select("id").single()
    : await admin.from("giveaways").upsert({ ...row, snapshot_frozen_at: null, created_by: user.id }, { onConflict: "organization_id,public_id" }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  const giveawayId = String(result.data.id);
  if (!existing?.data?.snapshot_frozen_at) {
    const { error: clearError } = await admin.from("giveaway_entries").delete().eq("giveaway_id", giveawayId);
    if (clearError) throw new Error(clearError.message);
  }
  const entryRows = parsed.entries.map((entry) => ({ giveaway_id: giveawayId, comment_id: entry.commentId, entry_number: entry.entryNumber, author_username: entry.username, comment_text: entry.comment, mentions: entry.mentions.split(/\s+/).filter(Boolean), comment_url: entry.commentUrl || null, comment_created_at: entry.commentCreatedAt, status: entry.status, last_seen_at: new Date().toISOString() }));
  if (entryRows.length) {
    const { error } = await admin.from("giveaway_entries").upsert(entryRows, { onConflict: "giveaway_id,comment_id" });
    if (error) throw new Error(error.message);
  }
  if (!wasFrozen && frozenAt) {
    const { error: freezeError } = await admin.from("giveaways").update({ snapshot_frozen_at: frozenAt }).eq("id", giveawayId).is("snapshot_frozen_at", null);
    if (freezeError) throw new Error("Nao foi possivel congelar o snapshot do sorteio.");
  }
  const historyRows = parsed.history.map((event) => ({ external_event_id: event.id, giveaway_id: giveawayId, event_type: event.type, message: event.message, detail: event.detail ?? null, actor_user_id: user.id, created_at: event.timestamp }));
  if (historyRows.length) {
    const { error } = await admin.from("giveaway_audit_events").upsert(historyRows, { onConflict: "giveaway_id,external_event_id", ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  }
  return { databaseId: giveawayId, snapshotFrozenAt: frozenAt };
}

export async function loadLatestGiveawaySession(): Promise<SorteioSession | null> {
  const { organization, admin } = await context();
  const { data: giveaway, error } = await admin.from("giveaways").select("*").eq("organization_id", organization.id).order("updated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!giveaway) return null;
  const [{ data: rows, error: entriesError }, { data: events, error: eventsError }] = await Promise.all([
    admin.from("giveaway_entries").select("*").eq("giveaway_id", giveaway.id).order("entry_number"),
    admin.from("giveaway_audit_events").select("*").eq("giveaway_id", giveaway.id).order("created_at"),
  ]);
  if (entriesError || eventsError) throw new Error(entriesError?.message ?? eventsError?.message);
  const state = (giveaway.state ?? {}) as { currentChecklist?: SorteioSession["currentChecklist"]; disqualifications?: SorteioSession["disqualifications"] };
  return {
    databaseId: String(giveaway.id), id: String(giveaway.public_id), createdAt: String(giveaway.created_at), importedFileName: giveaway.source_file_name as string | null,
    importedAt: giveaway.imported_at as string | null,
    entries: (rows ?? []).map((row) => ({ entryNumber: Number(row.entry_number), commentId: String(row.comment_id), username: String(row.author_username), comment: String(row.comment_text), mentionsCount: Array.isArray(row.mentions) ? row.mentions.length : 0, mentions: Array.isArray(row.mentions) ? row.mentions.join(" ") : "", commentUrl: String(row.comment_url ?? ""), commentCreatedAt: row.comment_created_at ? String(row.comment_created_at) : null, chance: "1", status: row.status as "active" | "disqualified" })),
    status: giveaway.status as SorteioSession["status"], currentWinnerCommentId: giveaway.current_winner_comment_id as string | null, currentDrawAt: giveaway.current_draw_at as string | null,
    currentChecklist: state.currentChecklist ?? { follows: false, liked: false, taggedFriends: false, sharedStory: false },
    disqualifications: state.disqualifications ?? [], confirmedWinner: giveaway.confirmed_winner_comment_id ? { commentId: String(giveaway.confirmed_winner_comment_id), confirmedAt: String(giveaway.confirmed_at) } : null,
    history: (events ?? []).map((event) => ({ id: String(event.external_event_id), timestamp: String(event.created_at), type: event.event_type as SorteioSession["history"][number]["type"], message: String(event.message), detail: event.detail ? String(event.detail) : undefined })),
    source: giveaway.source as "csv" | "instagram", instagramMediaId: giveaway.instagram_media_id as string | null, instagramMediaPermalink: giveaway.instagram_media_permalink as string | null,
    instagramIntegrationId: giveaway.instagram_integration_id as string | null, snapshotFrozenAt: giveaway.snapshot_frozen_at as string | null,
  };
}
