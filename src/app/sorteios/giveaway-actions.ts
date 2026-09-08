"use server";

import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { SorteioSession } from "@/components/sorteios/types";
import { requireGiveawayAdminContext } from "@/lib/giveaways/admin-context";
import {
  canChangeGiveawayPost,
  canImportGiveawayCsv,
  DEFAULT_GIVEAWAY_RULES,
  giveawayHubSection,
  giveawayStatusLabel,
  isSnapshotMutableStatus,
  normalizeGiveawayStatus,
  type GiveawayHubSection,
} from "@/lib/giveaways/status";
import { persistedGiveawayStatus, sessionFromGiveawayRows, type GiveawayRow } from "@/lib/giveaways/session";
import { assertGiveawaySourceIntegrity } from "@/lib/giveaways/source-integrity";
import { assertFrozenSnapshotInvariant, assertUniqueCommentIds } from "@/lib/instagram/normalize";
import { isMissingGiveawaySchemaError, resolveOptionalGiveawaySchema } from "@/lib/instagram/database-readiness";
import { assertNumericInstagramMediaId } from "@/lib/giveaways/media";

export type GiveawayBootstrap = {
  session: SorteioSession | null;
  persistence: "available" | "database_not_ready";
};

export type GiveawayListItem = {
  id: string;
  publicId: string;
  name: string;
  source: "csv" | "instagram";
  status: string;
  statusLabel: string;
  section: GiveawayHubSection;
  permalink: string | null;
  createdAt: string;
  comments: number;
  uniqueParticipants: number;
  chances: number;
  winnerUsername: string | null;
  winnerConfirmed: boolean;
  snapshotFrozen: boolean;
};

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional().nullable(),
  source: z.enum(["csv", "instagram"]),
  instagramMedia: z.object({
    mediaId: z.string().regex(/^\d+$/),
    mediaType: z.string().max(40),
    permalink: z.string().url().max(500),
    caption: z.string().max(4000),
    thumbnailUrl: z.string().max(2000),
    publishedAt: z.string().max(80),
  }).optional().nullable(),
});

const sessionSchema = z.object({
  databaseId: z.string().uuid().nullable(),
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  createdAt: z.string(),
  importedFileName: z.string().max(255).nullable(),
  importedAt: z.string().nullable(),
  entries: z.array(z.object({
    entryNumber: z.number().int().positive(),
    commentId: z.string().min(1).max(255),
    username: z.string().min(1).max(255),
    comment: z.string().max(10000),
    mentionsCount: z.number().int().nonnegative().nullable(),
    mentions: z.string().max(5000),
    commentUrl: z.string().max(2000),
    commentCreatedAt: z.string().nullable(),
    chance: z.string().max(255),
    status: z.enum(["active", "disqualified"]),
  })).max(100000),
  status: z.enum(["empty", "draft", "preparing", "ready", "drawing", "running", "awaiting_validation", "finalized", "completed", "cancelled"]),
  currentWinnerCommentId: z.string().nullable(),
  currentDrawAt: z.string().nullable(),
  currentChecklist: z.object({ follows: z.boolean(), liked: z.boolean(), taggedFriends: z.boolean(), sharedStory: z.boolean() }),
  disqualifications: z.array(z.unknown()),
  confirmedWinner: z.object({ commentId: z.string(), confirmedAt: z.string() }).nullable(),
  history: z.array(z.object({ id: z.string(), timestamp: z.string(), type: z.string(), message: z.string(), detail: z.string().optional() })),
  source: z.enum(["csv", "instagram"]),
  instagramMediaId: z.string().nullable(),
  instagramMediaPermalink: z.string().nullable(),
  instagramMediaType: z.string().nullable().optional(),
  instagramCaptionSnapshot: z.string().nullable().optional(),
  instagramThumbnailUrl: z.string().nullable().optional(),
  instagramPublishedAt: z.string().nullable().optional(),
  instagramIntegrationId: z.string().uuid().nullable(),
  snapshotFrozenAt: z.string().nullable(),
  rules: z.object({ chancePerComment: z.number(), minMentions: z.number() }).optional(),
});

function toTimestamptz(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function generatePublicId(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const seq = randomBytes(2).toString("hex").toUpperCase();
  return `MILITRIN-${year}-${month}${day}-${seq}`;
}

async function loadGiveawayRow(admin: ReturnType<typeof import("@/lib/supabase/admin").createServiceRoleSupabaseClient>, organizationId: string, giveawayId: string) {
  const { data, error } = await admin.from("giveaways").select("*").eq("id", giveawayId).eq("organization_id", organizationId).maybeSingle();
  if (error) throw new Error("Nao foi possivel carregar o sorteio.");
  return data;
}

export async function listGiveaways(): Promise<{ items: GiveawayListItem[]; persistence: "available" | "database_not_ready" }> {
  const { organization, admin } = await requireGiveawayAdminContext();
  const { data: giveaways, error } = await admin.from("giveaways").select("id,public_id,name,source,status,created_at,snapshot_frozen_at,instagram_media_permalink,current_winner_comment_id,confirmed_winner_comment_id").eq("organization_id", organization.id).order("created_at", { ascending: false });
  const ready = resolveOptionalGiveawaySchema(giveaways, error);
  if (!ready.databaseReady) return { items: [], persistence: "database_not_ready" };
  const rows = ready.data ?? [];
  if (!rows.length) return { items: [], persistence: "available" };
  const ids = rows.map((row) => String(row.id));
  const { data: entries, error: entriesError } = await admin.from("giveaway_entries").select("giveaway_id,author_username,comment_id").in("giveaway_id", ids);
  if (entriesError) {
    if (isMissingGiveawaySchemaError(entriesError)) return { items: [], persistence: "database_not_ready" };
    throw new Error("Nao foi possivel listar as participacoes dos sorteios.");
  }
  const byGiveaway = new Map<string, { comments: number; usernames: Set<string>; byComment: Map<string, string> }>();
  for (const entry of entries ?? []) {
    const giveawayId = String(entry.giveaway_id);
    const current = byGiveaway.get(giveawayId) ?? { comments: 0, usernames: new Set<string>(), byComment: new Map<string, string>() };
    current.comments += 1;
    current.usernames.add(String(entry.author_username).toLowerCase());
    current.byComment.set(String(entry.comment_id), String(entry.author_username));
    byGiveaway.set(giveawayId, current);
  }
  return {
    persistence: "available",
    items: rows.map((row) => {
      const stats = byGiveaway.get(String(row.id));
      const winnerId = (row.confirmed_winner_comment_id ?? row.current_winner_comment_id) as string | null;
      return {
        id: String(row.id),
        publicId: String(row.public_id),
        name: String(row.name || row.public_id),
        source: row.source as "csv" | "instagram",
        status: String(row.status),
        statusLabel: giveawayStatusLabel(String(row.status)),
        section: giveawayHubSection(String(row.status)),
        permalink: (row.instagram_media_permalink as string | null) ?? null,
        createdAt: String(row.created_at),
        comments: stats?.comments ?? 0,
        uniqueParticipants: stats?.usernames.size ?? 0,
        chances: stats?.comments ?? 0,
        winnerUsername: winnerId ? stats?.byComment.get(winnerId) ?? null : null,
        winnerConfirmed: Boolean(row.confirmed_winner_comment_id),
        snapshotFrozen: Boolean(row.snapshot_frozen_at),
      };
    }),
  };
}

export async function loadGiveawaySession(giveawayId: string): Promise<GiveawayBootstrap> {
  if (!z.string().uuid().safeParse(giveawayId).success) return { session: null, persistence: "available" };
  const { organization, admin } = await requireGiveawayAdminContext();
  const { data: giveaway, error } = await admin.from("giveaways").select("*").eq("id", giveawayId).eq("organization_id", organization.id).maybeSingle();
  const giveawayResult = resolveOptionalGiveawaySchema(giveaway, error);
  if (!giveawayResult.databaseReady) return { session: null, persistence: "database_not_ready" };
  if (!giveaway) return { session: null, persistence: "available" };
  const [{ data: rows, error: entriesError }, { data: events, error: eventsError }] = await Promise.all([
    admin.from("giveaway_entries").select("*").eq("giveaway_id", giveaway.id).order("entry_number"),
    admin.from("giveaway_audit_events").select("*").eq("giveaway_id", giveaway.id).order("created_at"),
  ]);
  if (entriesError || eventsError) {
    if (isMissingGiveawaySchemaError(entriesError) || isMissingGiveawaySchemaError(eventsError)) return { session: null, persistence: "database_not_ready" };
    throw new Error(entriesError?.message ?? eventsError?.message);
  }
  return {
    persistence: "available",
    session: sessionFromGiveawayRows(giveaway as GiveawayRow, rows ?? [], events ?? []),
  };
}

export async function createGiveaway(input: z.infer<typeof createSchema>) {
  const parsed = createSchema.parse(input);
  if (parsed.source === "instagram" && !parsed.instagramMedia) {
    throw new Error("Selecione uma publicacao do Instagram antes de criar o sorteio.");
  }
  if (parsed.source === "csv" && parsed.instagramMedia) {
    throw new Error("Um sorteio CSV nao pode nascer vinculado a uma publicacao do Instagram.");
  }
  const { user, organization, admin } = await requireGiveawayAdminContext();
  let instagramIntegrationId: string | null = null;
  if (parsed.source === "instagram") {
    const { data: integration, error } = await admin.from("instagram_integrations").select("id").eq("organization_id", organization.id).is("disconnected_at", null).maybeSingle();
    if (error || !integration) throw new Error("Conecte uma conta profissional do Instagram primeiro.");
    instagramIntegrationId = String(integration.id);
    assertNumericInstagramMediaId(parsed.instagramMedia!.mediaId);
  }
  const publicId = generatePublicId();
  const status = parsed.source === "instagram" ? "preparing" : "draft";
  const { data, error } = await admin.from("giveaways").insert({
    organization_id: organization.id,
    public_id: publicId,
    name: parsed.name,
    description: parsed.description || null,
    source: parsed.source,
    status,
    instagram_integration_id: instagramIntegrationId,
    instagram_media_id: parsed.instagramMedia?.mediaId ?? null,
    instagram_media_type: parsed.instagramMedia?.mediaType || null,
    instagram_media_permalink: parsed.instagramMedia?.permalink ?? null,
    instagram_media_caption: parsed.instagramMedia?.caption || null,
    instagram_thumbnail_url: parsed.instagramMedia?.thumbnailUrl || null,
    instagram_published_at: toTimestamptz(parsed.instagramMedia?.publishedAt),
    snapshot_frozen_at: null,
    state: { rules: DEFAULT_GIVEAWAY_RULES },
    created_by: user.id,
    updated_by: user.id,
  }).select("id").single();
  if (error || !data) throw new Error("Nao foi possivel criar o sorteio.");
  return { id: String(data.id), publicId, status };
}

export async function persistGiveawaySession(input: SorteioSession) {
  const parsedResult = sessionSchema.safeParse(input);
  if (!parsedResult.success) throw new Error("Nao foi possivel validar o sorteio para salvar.");
  const parsed = parsedResult.data as SorteioSession;
  if (!parsed.databaseId) throw new Error("Sorteio persistido e obrigatorio. Crie o sorteio pela central antes de salvar.");
  assertUniqueCommentIds(parsed.entries.map((entry) => entry.commentId));
  if (parsed.currentWinnerCommentId && !parsed.entries.some((entry) => entry.commentId === parsed.currentWinnerCommentId)) throw new Error("O vencedor selecionado nao pertence ao snapshot do sorteio.");
  if (parsed.confirmedWinner && parsed.confirmedWinner.commentId !== parsed.currentWinnerCommentId) throw new Error("O vencedor confirmado nao corresponde ao vencedor selecionado.");
  assertGiveawaySourceIntegrity({
    source: parsed.source,
    instagramIntegrationId: parsed.instagramIntegrationId,
    instagramMediaId: parsed.instagramMediaId,
    instagramMediaPermalink: parsed.instagramMediaPermalink,
  });
  const { user, organization, admin } = await requireGiveawayAdminContext();
  const existing = await admin.from("giveaways").select("snapshot_frozen_at,source,source_file_name,instagram_integration_id,instagram_media_id,instagram_media_permalink,status").eq("id", parsed.databaseId).eq("organization_id", organization.id).maybeSingle();
  if (!existing.data) throw new Error("Sorteio nao encontrado nesta organizacao.");
  const wasFrozen = Boolean(existing.data.snapshot_frozen_at);
  if (wasFrozen) {
    const { data: frozenRows, error: frozenError } = await admin.from("giveaway_entries").select("comment_id").eq("giveaway_id", parsed.databaseId);
    if (frozenError) throw new Error("Nao foi possivel validar o snapshot congelado.");
    assertFrozenSnapshotInvariant({
      source: existing.data.source as "csv" | "instagram",
      sourceFileName: existing.data.source_file_name as string | null,
      instagramIntegrationId: existing.data.instagram_integration_id as string | null,
      instagramMediaId: existing.data.instagram_media_id as string | null,
      instagramMediaPermalink: existing.data.instagram_media_permalink as string | null,
      commentIds: (frozenRows ?? []).map((row) => String(row.comment_id)),
    }, {
      source: parsed.source,
      sourceFileName: parsed.importedFileName,
      instagramIntegrationId: parsed.instagramIntegrationId,
      instagramMediaId: parsed.instagramMediaId,
      instagramMediaPermalink: parsed.instagramMediaPermalink,
      commentIds: parsed.entries.map((entry) => entry.commentId),
    });
    const nextStatus = persistedGiveawayStatus(normalizeGiveawayStatus(parsed.status));
    const result = await admin.from("giveaways").update({
      status: nextStatus,
      current_winner_comment_id: parsed.currentWinnerCommentId,
      current_draw_at: parsed.currentDrawAt,
      confirmed_winner_comment_id: parsed.confirmedWinner?.commentId ?? null,
      confirmed_at: parsed.confirmedWinner?.confirmedAt ?? null,
      state: { currentChecklist: parsed.currentChecklist, disqualifications: parsed.disqualifications, rules: parsed.rules ?? DEFAULT_GIVEAWAY_RULES },
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    }).eq("id", parsed.databaseId).eq("organization_id", organization.id).select("id").single();
    if (result.error) throw new Error("Nao foi possivel salvar o sorteio.");
    const historyRows = parsed.history.map((event) => ({
      external_event_id: event.id,
      giveaway_id: parsed.databaseId,
      event_type: event.type,
      message: event.message,
      detail: event.detail ?? null,
      actor_user_id: user.id,
      created_at: event.timestamp,
    }));
    if (historyRows.length) {
      const { error } = await admin.from("giveaway_audit_events").upsert(historyRows, { onConflict: "giveaway_id,external_event_id", ignoreDuplicates: true });
      if (error) throw new Error("Nao foi possivel salvar o historico do sorteio.");
    }
    return { databaseId: parsed.databaseId, snapshotFrozenAt: existing.data.snapshot_frozen_at as string };
  }
  const nextStatus = persistedGiveawayStatus(normalizeGiveawayStatus(parsed.status));
  const frozenAt = parsed.snapshotFrozenAt ?? (!isSnapshotMutableStatus(nextStatus) ? new Date().toISOString() : null);
  const row = {
    name: parsed.name || parsed.id,
    description: parsed.description ?? null,
    source: parsed.source,
    status: nextStatus,
    source_file_name: parsed.importedFileName,
    instagram_integration_id: parsed.instagramIntegrationId,
    instagram_media_id: parsed.instagramMediaId,
    instagram_media_permalink: parsed.instagramMediaPermalink,
    instagram_media_caption: parsed.instagramCaptionSnapshot ?? null,
    instagram_media_type: parsed.instagramMediaType ?? null,
    instagram_thumbnail_url: parsed.instagramThumbnailUrl ?? null,
    instagram_published_at: toTimestamptz(parsed.instagramPublishedAt),
    imported_at: parsed.importedAt,
    synced_at: parsed.source === "instagram" ? parsed.importedAt : null,
    current_winner_comment_id: parsed.currentWinnerCommentId,
    current_draw_at: parsed.currentDrawAt,
    confirmed_winner_comment_id: parsed.confirmedWinner?.commentId ?? null,
    confirmed_at: parsed.confirmedWinner?.confirmedAt ?? null,
    state: { currentChecklist: parsed.currentChecklist, disqualifications: parsed.disqualifications, rules: parsed.rules ?? DEFAULT_GIVEAWAY_RULES },
    updated_by: user.id,
    updated_at: new Date().toISOString(),
  };
  const result = await admin.from("giveaways").update({ ...row, snapshot_frozen_at: wasFrozen ? frozenAt : null }).eq("id", parsed.databaseId).eq("organization_id", organization.id).select("id").single();
  if (result.error) throw new Error("Nao foi possivel salvar o sorteio.");
  const giveawayId = String(result.data.id);
  if (!wasFrozen) {
    const { error: clearError } = await admin.from("giveaway_entries").delete().eq("giveaway_id", giveawayId);
    if (clearError) throw new Error("Nao foi possivel atualizar as participacoes.");
  }
  const entryRows = parsed.entries.map((entry) => ({
    giveaway_id: giveawayId,
    comment_id: entry.commentId,
    entry_number: entry.entryNumber,
    author_username: entry.username,
    comment_text: entry.comment,
    mentions: entry.mentions.split(/\s+/).filter(Boolean),
    comment_url: entry.commentUrl || null,
    comment_created_at: entry.commentCreatedAt,
    status: entry.status,
    last_seen_at: new Date().toISOString(),
  }));
  if (entryRows.length) {
    const { error } = await admin.from("giveaway_entries").upsert(entryRows, { onConflict: "giveaway_id,comment_id" });
    if (error) throw new Error("Nao foi possivel salvar as participacoes.");
  }
  if (!wasFrozen && frozenAt) {
    const { error: freezeError } = await admin.from("giveaways").update({ snapshot_frozen_at: frozenAt }).eq("id", giveawayId).is("snapshot_frozen_at", null);
    if (freezeError) throw new Error("Nao foi possivel congelar o snapshot do sorteio.");
  }
  const historyRows = parsed.history.map((event) => ({
    external_event_id: event.id,
    giveaway_id: giveawayId,
    event_type: event.type,
    message: event.message,
    detail: event.detail ?? null,
    actor_user_id: user.id,
    created_at: event.timestamp,
  }));
  if (historyRows.length) {
    const { error } = await admin.from("giveaway_audit_events").upsert(historyRows, { onConflict: "giveaway_id,external_event_id", ignoreDuplicates: true });
    if (error) throw new Error("Nao foi possivel salvar o historico do sorteio.");
  }
  return { databaseId: giveawayId, snapshotFrozenAt: frozenAt };
}

export async function assertGiveawayCanChangePost(giveawayId: string) {
  const { organization, admin } = await requireGiveawayAdminContext();
  const giveaway = await loadGiveawayRow(admin, organization.id, giveawayId);
  if (!giveaway) throw new Error("Sorteio nao encontrado nesta organizacao.");
  if (!canChangeGiveawayPost(String(giveaway.status), giveaway.snapshot_frozen_at as string | null)) {
    throw new Error("A publicacao deste sorteio nao pode ser alterada.");
  }
  return giveaway;
}

export async function assertGiveawayCanImportCsv(giveawayId: string) {
  const { organization, admin } = await requireGiveawayAdminContext();
  const giveaway = await loadGiveawayRow(admin, organization.id, giveawayId);
  if (!giveaway) throw new Error("Sorteio nao encontrado nesta organizacao.");
  if (giveaway.source !== "csv") throw new Error("Este sorteio nao usa CSV como fonte.");
  if (!canImportGiveawayCsv(String(giveaway.status), giveaway.snapshot_frozen_at as string | null)) {
    throw new Error("A importacao CSV esta bloqueada neste sorteio.");
  }
  return giveaway;
}
