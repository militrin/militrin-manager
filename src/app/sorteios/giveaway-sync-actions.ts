"use server";

import "server-only";
import { z } from "zod";
import type { ParticipationEntry } from "@/components/sorteios/types";
import { requireGiveawayAdminContext } from "@/lib/giveaways/admin-context";
import { assertNumericInstagramMediaId, toInstagramMediaCard, type InstagramMediaCard } from "@/lib/giveaways/media";
import { canChangeGiveawayPost, canSyncGiveawayComments } from "@/lib/giveaways/status";
import { getInstagramMedia, listInstagramComments, listInstagramMediaPage } from "@/lib/instagram/meta-api";
import { normalizeUniqueInstagramComments, resolveOwnedInstagramMedia } from "@/lib/instagram/normalize";
import { requireConnectedInstagramIntegration } from "@/lib/instagram/runtime-integration";

const mediaSelectionSchema = z.object({
  giveawayId: z.string().uuid(),
  mediaId: z.string().regex(/^\d+$/),
});

function toTimestamptz(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

export async function loadInstagramMediaPage(after?: string | null): Promise<{ items: InstagramMediaCard[]; nextCursor: string | null }> {
  const integration = await requireConnectedInstagramIntegration();
  const page = await listInstagramMediaPage(integration.userId, integration.token, after);
  return {
    items: page.items.map(toInstagramMediaCard),
    nextCursor: page.nextCursor,
  };
}

export async function selectGiveawayInstagramMedia(input: z.infer<typeof mediaSelectionSchema>) {
  const parsed = mediaSelectionSchema.parse(input);
  const integration = await requireConnectedInstagramIntegration();
  const { organization, admin, user } = await requireGiveawayAdminContext();
  const { data: giveaway, error } = await admin.from("giveaways").select("id,source,status,snapshot_frozen_at,instagram_integration_id").eq("id", parsed.giveawayId).eq("organization_id", organization.id).maybeSingle();
  if (error || !giveaway) throw new Error("Sorteio nao encontrado nesta organizacao.");
  if (giveaway.source !== "instagram") throw new Error("Este sorteio nao usa Instagram como fonte.");
  if (!canChangeGiveawayPost(String(giveaway.status), giveaway.snapshot_frozen_at as string | null)) {
    throw new Error("A publicacao deste sorteio nao pode ser alterada.");
  }
  if (giveaway.instagram_integration_id && String(giveaway.instagram_integration_id) !== integration.integrationId) {
    throw new Error("Este sorteio pertence a outra conexao do Instagram.");
  }
  const media = await getInstagramMedia(parsed.mediaId, integration.token);
  const owned = resolveOwnedInstagramMedia([media], parsed.mediaId);
  const card = toInstagramMediaCard(owned);
  const { error: updateError } = await admin.from("giveaways").update({
    instagram_integration_id: integration.integrationId,
    instagram_media_id: card.mediaId,
    instagram_media_type: card.mediaType || null,
    instagram_media_permalink: card.permalink,
    instagram_media_caption: card.caption || null,
    instagram_thumbnail_url: card.thumbnailUrl || null,
    instagram_published_at: toTimestamptz(card.timestamp),
    status: "preparing",
    updated_by: user.id,
    updated_at: new Date().toISOString(),
  }).eq("id", parsed.giveawayId).eq("organization_id", organization.id).is("snapshot_frozen_at", null);
  if (updateError) throw new Error("Nao foi possivel vincular a publicacao ao sorteio.");
  return card;
}

export async function syncGiveawayComments(giveawayId: string): Promise<{
  entries: ParticipationEntry[];
  mediaId: string;
  permalink: string;
  integrationId: string;
  syncedAt: string;
}> {
  if (!z.string().uuid().safeParse(giveawayId).success) throw new Error("Sorteio invalido.");
  const integration = await requireConnectedInstagramIntegration();
  const { organization, admin, user } = await requireGiveawayAdminContext();
  const { data: giveaway, error } = await admin.from("giveaways").select("id,source,status,snapshot_frozen_at,instagram_media_id,instagram_integration_id").eq("id", giveawayId).eq("organization_id", organization.id).maybeSingle();
  if (error || !giveaway) throw new Error("Sorteio nao encontrado nesta organizacao.");
  if (giveaway.source !== "instagram") throw new Error("Este sorteio nao usa Instagram como fonte.");
  if (!canSyncGiveawayComments(String(giveaway.status), giveaway.snapshot_frozen_at as string | null)) {
    throw new Error("A sincronizacao esta bloqueada neste sorteio.");
  }
  const mediaId = String(giveaway.instagram_media_id ?? "");
  assertNumericInstagramMediaId(mediaId);
  const media = await getInstagramMedia(mediaId, integration.token);
  const owned = resolveOwnedInstagramMedia([media], mediaId);
  const comments = await listInstagramComments(owned.id, integration.token);
  const entries = normalizeUniqueInstagramComments(comments, owned.permalink!);
  const syncedAt = new Date().toISOString();
  const { error: clearError } = await admin.from("giveaway_entries").delete().eq("giveaway_id", giveawayId);
  if (clearError) throw new Error("Nao foi possivel atualizar as participacoes sincronizadas.");
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
    if (upsertError) throw new Error("Nao foi possivel gravar os comentarios sincronizados.");
  }
  const { error: updateError } = await admin.from("giveaways").update({
    synced_at: syncedAt,
    imported_at: syncedAt,
    status: "ready",
    instagram_media_permalink: owned.permalink,
    instagram_media_caption: owned.caption ?? null,
    instagram_media_type: owned.media_type ?? null,
    instagram_thumbnail_url: owned.thumbnail_url ?? owned.media_url ?? null,
    instagram_published_at: toTimestamptz(owned.timestamp),
    updated_by: user.id,
    updated_at: syncedAt,
  }).eq("id", giveawayId).eq("organization_id", organization.id).is("snapshot_frozen_at", null);
  if (updateError) throw new Error("Nao foi possivel atualizar o sorteio apos a sincronizacao.");
  return { entries, mediaId: owned.id, permalink: owned.permalink!, integrationId: integration.integrationId, syncedAt };
}
