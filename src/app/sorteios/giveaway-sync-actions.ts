"use server";

import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ParticipationEntry } from "@/components/sorteios/types";
import { requireGiveawayAdminContext } from "@/lib/giveaways/admin-context";
import { assertNumericInstagramMediaId, toInstagramMediaCard, type InstagramMediaCard } from "@/lib/giveaways/media";
import { canChangeGiveawayPost, canSyncGiveawayComments, giveawayRequiresPostChangeConfirmation, statusAfterCommentSync } from "@/lib/giveaways/status";
import {
  instagramCommentsSyncUserCopy,
  instagramMediaLoadUserCopy,
  logInstagramGraphEvent,
  reconnectRequiredForKind,
  sanitizeMetaErrorMessage,
  type InstagramGraphFailureKind,
} from "@/lib/instagram/meta-error";
import { getInstagramMedia, listInstagramComments, listInstagramMediaPage } from "@/lib/instagram/meta-api";
import { normalizeUniqueInstagramComments, resolveOwnedInstagramMedia } from "@/lib/instagram/normalize";
import { requireConnectedInstagramIntegration } from "@/lib/instagram/runtime-integration";

const mediaSelectionSchema = z.object({
  giveawayId: z.string().uuid(),
  mediaId: z.string().regex(/^\d+$/),
  confirmReplaceComments: z.boolean().optional(),
});

function toTimestamptz(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function isNextControlFlowError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const digest = (error as { digest?: string }).digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest.startsWith("NEXT_NOT_FOUND"));
}

function isReconnectIntegrationError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /conecte|desativada|expirou/i.test(error.message);
}

export type InstagramActionFailure = {
  ok: false;
  kind: InstagramGraphFailureKind | "unknown";
  message: string;
  detail: string | null;
  reconnectRequired: boolean;
  canReconnect: boolean;
};

export type LoadInstagramMediaPageResult =
  | { ok: true; items: InstagramMediaCard[]; nextCursor: string | null }
  | InstagramActionFailure;

export type SelectGiveawayInstagramMediaResult =
  | { ok: true } & InstagramMediaCard & { commentsCleared: number; status: "preparing" }
  | InstagramActionFailure;

export type SyncGiveawayCommentsResult =
  | {
      ok: true;
      entries: ParticipationEntry[];
      mediaId: string;
      permalink: string;
      integrationId: string;
      syncedAt: string;
      status: "preparing" | "ready";
      pagesFetched: number;
    }
  | InstagramActionFailure;

function actionFailure(
  kind: InstagramGraphFailureKind | "unknown",
  copy: { message: string; detail: string; reconnectRequired?: boolean; canReconnect?: boolean },
): InstagramActionFailure {
  const reconnectRequired = copy.reconnectRequired ?? copy.canReconnect ?? reconnectRequiredForKind(kind === "unknown" ? "unknown" : kind);
  return {
    ok: false,
    kind,
    message: copy.message,
    detail: copy.detail,
    reconnectRequired,
    canReconnect: reconnectRequired,
  };
}

function logActionFailure(event: string, extra: Record<string, unknown>) {
  logInstagramGraphEvent({ event, ...extra });
}

export async function loadInstagramMediaPage(after?: string | null): Promise<LoadInstagramMediaPageResult> {
  try {
    const integration = await requireConnectedInstagramIntegration();
    const page = await listInstagramMediaPage(integration.token, after, { igUserId: integration.userId });
    if (!page.ok) {
      const copy = instagramMediaLoadUserCopy(page.kind);
      logActionFailure("media_page_failed", {
        operation: "media_page",
        endpoint: "me/media",
        httpStatus: page.httpStatus,
        errorCode: page.errorCode ?? null,
        errorSubcode: page.errorSubcode ?? null,
        errorType: page.errorType ?? null,
        fbtraceId: page.fbtraceId ?? null,
        sanitizedMessage: page.sanitizedMessage,
        kind: page.kind,
        durationMs: page.durationMs ?? null,
      });
      return actionFailure(page.kind, copy);
    }
    const items = page.items
      .filter((item) => /^\d+$/.test(String(item.id ?? "")))
      .map((item) => toInstagramMediaCard({
        id: String(item.id),
        media_type: item.media_type ?? "",
        permalink: item.permalink ?? "",
        caption: item.caption ?? "",
        timestamp: item.timestamp ?? "",
        thumbnail_url: item.thumbnail_url,
        media_url: item.media_url,
      }));
    logInstagramGraphEvent({
      event: "media_page_returned",
      operation: "media_page",
      endpoint: "me/media",
      itemsFetched: items.length,
      pagesFetched: 1,
      hasNext: Boolean(page.nextCursor),
    });
    return { ok: true, items, nextCursor: page.nextCursor };
  } catch (error) {
    if (isNextControlFlowError(error)) throw error;
    const kind: InstagramGraphFailureKind = isReconnectIntegrationError(error) ? "expired_token" : "unknown";
    logActionFailure("media_page_unhandled", {
      operation: "media_page",
      kind,
      sanitizedMessage: sanitizeMetaErrorMessage(error instanceof Error ? error.message : "unhandled"),
    });
    return actionFailure(kind, instagramMediaLoadUserCopy(kind));
  }
}

export async function selectGiveawayInstagramMedia(input: z.infer<typeof mediaSelectionSchema>): Promise<SelectGiveawayInstagramMediaResult> {
  try {
    const parsed = mediaSelectionSchema.parse(input);
    const integration = await requireConnectedInstagramIntegration();
    const { organization, admin, user } = await requireGiveawayAdminContext();
    const { data: giveaway, error } = await admin.from("giveaways").select("id,source,status,snapshot_frozen_at,instagram_integration_id,instagram_media_id,instagram_media_permalink").eq("id", parsed.giveawayId).eq("organization_id", organization.id).maybeSingle();
    if (error || !giveaway) {
      return actionFailure("unknown", { message: "Sorteio nao encontrado nesta organizacao.", detail: "Atualize a página e tente novamente." });
    }
    if (giveaway.source !== "instagram") {
      return actionFailure("unknown", { message: "Este sorteio nao usa Instagram como fonte.", detail: "Escolha um sorteio com fonte Instagram." });
    }
    if (!canChangeGiveawayPost(String(giveaway.status), giveaway.snapshot_frozen_at as string | null)) {
      return actionFailure("unknown", { message: "A publicacao deste sorteio nao pode ser alterada.", detail: "O snapshot já está congelado." });
    }
    if (giveaway.instagram_integration_id && String(giveaway.instagram_integration_id) !== integration.integrationId) {
      return actionFailure("unknown", { message: "Este sorteio pertence a outra conexao do Instagram.", detail: "Reconecte a conta usada neste sorteio." });
    }
    const mediaResult = await getInstagramMedia(parsed.mediaId, integration.token);
    if (!mediaResult.ok) {
      const copy = instagramMediaLoadUserCopy(mediaResult.kind);
      logActionFailure("media_get_failed", {
        operation: "media_get",
        endpoint: "media",
        httpStatus: mediaResult.httpStatus,
        errorCode: mediaResult.errorCode ?? null,
        errorSubcode: mediaResult.errorSubcode ?? null,
        fbtraceId: mediaResult.fbtraceId ?? null,
        kind: mediaResult.kind,
      });
      return actionFailure(mediaResult.kind, copy);
    }
    const owned = resolveOwnedInstagramMedia([mediaResult.media], parsed.mediaId);
    const card = toInstagramMediaCard(owned);
    const { count, error: countError } = await admin.from("giveaway_entries").select("id", { count: "exact", head: true }).eq("giveaway_id", parsed.giveawayId);
    if (countError) {
      return actionFailure("unknown", { message: "Nao foi possivel verificar os comentarios deste sorteio.", detail: "Tente novamente." });
    }
    const existingComments = count ?? 0;
    if (giveawayRequiresPostChangeConfirmation(existingComments) && !parsed.confirmReplaceComments) {
      return actionFailure("unknown", {
        message: "Confirme a troca da publicacao. Os comentarios sincronizados deste rascunho serao removidos.",
        detail: "Confirme para substituir a publicação vinculada.",
      });
    }
    if (existingComments > 0) {
      const { error: clearError } = await admin.from("giveaway_entries").delete().eq("giveaway_id", parsed.giveawayId);
      if (clearError) {
        return actionFailure("unknown", { message: "Nao foi possivel remover os comentarios deste rascunho.", detail: "Tente novamente." });
      }
    }
    const now = new Date().toISOString();
    const { error: updateError } = await admin.from("giveaways").update({
      instagram_integration_id: integration.integrationId,
      instagram_media_id: card.mediaId,
      instagram_media_type: card.mediaType || null,
      instagram_media_permalink: card.permalink,
      instagram_media_caption: card.caption || null,
      instagram_thumbnail_url: card.thumbnailUrl || null,
      instagram_published_at: toTimestamptz(card.timestamp),
      status: "preparing",
      synced_at: null,
      imported_at: null,
      updated_by: user.id,
      updated_at: now,
    }).eq("id", parsed.giveawayId).eq("organization_id", organization.id).is("snapshot_frozen_at", null);
    if (updateError) {
      return actionFailure("unknown", { message: "Nao foi possivel vincular a publicacao ao sorteio.", detail: "Tente novamente." });
    }
    const previousPermalink = (giveaway.instagram_media_permalink as string | null) || "sem publicação";
    await admin.from("giveaway_audit_events").insert({
      external_event_id: randomUUID(),
      giveaway_id: parsed.giveawayId,
      event_type: "post_changed",
      message: "Publicação alterada",
      detail: `${previousPermalink} → ${card.permalink}${existingComments ? ` · ${existingComments} comentários removidos deste rascunho` : ""}`,
      actor_user_id: user.id,
      created_at: now,
    });
    return { ok: true, ...card, commentsCleared: existingComments, status: "preparing" as const };
  } catch (error) {
    if (isNextControlFlowError(error)) throw error;
    const kind: InstagramGraphFailureKind = isReconnectIntegrationError(error) ? "expired_token" : "unknown";
    logActionFailure("media_select_unhandled", {
      operation: "media_get",
      kind,
      sanitizedMessage: sanitizeMetaErrorMessage(error instanceof Error ? error.message : "unhandled"),
    });
    return actionFailure(kind, instagramMediaLoadUserCopy(kind));
  }
}

export async function syncGiveawayComments(giveawayId: string): Promise<SyncGiveawayCommentsResult> {
  try {
    if (!z.string().uuid().safeParse(giveawayId).success) {
      return actionFailure("unknown", { message: "Sorteio invalido.", detail: "Atualize a página e tente novamente." });
    }
    const integration = await requireConnectedInstagramIntegration();
    const { organization, admin, user } = await requireGiveawayAdminContext();
    const { data: giveaway, error } = await admin.from("giveaways").select("id,source,status,snapshot_frozen_at,instagram_media_id,instagram_integration_id").eq("id", giveawayId).eq("organization_id", organization.id).maybeSingle();
    if (error || !giveaway) {
      return actionFailure("unknown", { message: "Sorteio nao encontrado nesta organizacao.", detail: "Atualize a página e tente novamente." });
    }
    if (giveaway.source !== "instagram") {
      return actionFailure("unknown", { message: "Este sorteio nao usa Instagram como fonte.", detail: "Escolha um sorteio com fonte Instagram." });
    }
    if (!canSyncGiveawayComments(String(giveaway.status), giveaway.snapshot_frozen_at as string | null)) {
      return actionFailure("unknown", { message: "A sincronizacao esta bloqueada neste sorteio.", detail: "O snapshot já está congelado." });
    }
    const mediaId = String(giveaway.instagram_media_id ?? "");
    try {
      assertNumericInstagramMediaId(mediaId);
    } catch {
      return actionFailure("media_not_found", instagramCommentsSyncUserCopy("media_not_found"));
    }
    const mediaResult = await getInstagramMedia(mediaId, integration.token);
    if (!mediaResult.ok) {
      const copy = instagramCommentsSyncUserCopy(mediaResult.kind);
      logActionFailure("comments_media_get_failed", {
        operation: "comments",
        endpoint: "media",
        httpStatus: mediaResult.httpStatus,
        errorCode: mediaResult.errorCode ?? null,
        errorSubcode: mediaResult.errorSubcode ?? null,
        fbtraceId: mediaResult.fbtraceId ?? null,
        kind: mediaResult.kind,
      });
      return actionFailure(mediaResult.kind, copy);
    }
    const owned = resolveOwnedInstagramMedia([mediaResult.media], mediaId);
    const commentsResult = await listInstagramComments(owned.id, integration.token);
    if (!commentsResult.ok) {
      const copy = instagramCommentsSyncUserCopy(commentsResult.kind);
      logActionFailure("comments_failed", {
        operation: "comments",
        endpoint: "comments",
        httpStatus: commentsResult.httpStatus,
        errorCode: commentsResult.errorCode ?? null,
        errorSubcode: commentsResult.errorSubcode ?? null,
        fbtraceId: commentsResult.fbtraceId ?? null,
        kind: commentsResult.kind,
        pagesFetched: commentsResult.pagesFetched ?? null,
        itemsFetched: commentsResult.itemsFetched ?? null,
        durationMs: commentsResult.durationMs ?? null,
      });
      return actionFailure(commentsResult.kind, copy);
    }
    const entries = normalizeUniqueInstagramComments(commentsResult.items, owned.permalink!);
    const syncedAt = new Date().toISOString();
    const nextStatus = statusAfterCommentSync(entries.length);
    const { error: clearError } = await admin.from("giveaway_entries").delete().eq("giveaway_id", giveawayId);
    if (clearError) {
      return actionFailure("unknown", { message: "Nao foi possivel atualizar as participacoes sincronizadas.", detail: "Tente novamente." });
    }
    if (entries.length) {
      const { error: upsertError } = await admin.from("giveaway_entries").insert(entries.map((entry) => ({
        giveaway_id: giveawayId,
        comment_id: entry.commentId,
        entry_number: entry.entryNumber,
        author_username: entry.username,
        comment_text: entry.comment,
        mentions: entry.mentions.split(/\s+/).filter(Boolean),
        comment_url: entry.commentUrl || null,
        comment_created_at: entry.commentCreatedAt,
        status: entry.status,
      })));
      if (upsertError) {
        return actionFailure("unknown", { message: "Nao foi possivel gravar os comentarios sincronizados.", detail: "Tente novamente." });
      }
    }
    const { error: updateError } = await admin.from("giveaways").update({
      synced_at: syncedAt,
      imported_at: syncedAt,
      status: nextStatus,
      instagram_media_permalink: owned.permalink,
      instagram_media_caption: owned.caption ?? null,
      instagram_media_type: owned.media_type ?? null,
      instagram_thumbnail_url: owned.thumbnail_url ?? owned.media_url ?? null,
      instagram_published_at: toTimestamptz(owned.timestamp),
      updated_by: user.id,
      updated_at: syncedAt,
    }).eq("id", giveawayId).eq("organization_id", organization.id).is("snapshot_frozen_at", null);
    if (updateError) {
      return actionFailure("unknown", { message: "Nao foi possivel atualizar o sorteio apos a sincronizacao.", detail: "Tente novamente." });
    }
    await admin.from("giveaway_audit_events").insert({
      external_event_id: randomUUID(),
      giveaway_id: giveawayId,
      event_type: "import",
      message: entries.length ? "Comentários sincronizados pela API oficial da Meta" : "Nenhum comentário encontrado nesta publicação",
      detail: `${entries.length} comentários · mídia ${owned.id} · ${commentsResult.pagesFetched} página(s)`,
      actor_user_id: user.id,
      created_at: syncedAt,
    });
    logInstagramGraphEvent({
      event: "comments_synced",
      operation: "comments",
      endpoint: "comments",
      pagesFetched: commentsResult.pagesFetched,
      itemsFetched: commentsResult.items.length,
      uniqueEntries: entries.length,
    });
    return {
      ok: true,
      entries,
      mediaId: owned.id,
      permalink: owned.permalink!,
      integrationId: integration.integrationId,
      syncedAt,
      status: nextStatus,
      pagesFetched: commentsResult.pagesFetched,
    };
  } catch (error) {
    if (isNextControlFlowError(error)) throw error;
    const kind: InstagramGraphFailureKind = isReconnectIntegrationError(error) ? "expired_token" : "unknown";
    logActionFailure("comments_unhandled", {
      operation: "comments",
      kind,
      sanitizedMessage: sanitizeMetaErrorMessage(error instanceof Error ? error.message : "unhandled"),
    });
    return actionFailure(kind, instagramCommentsSyncUserCopy(kind));
  }
}
