import { EMPTY_CHECKLIST, type ParticipationEntry, type SorteioSession } from "@/components/sorteios/types";
import { DEFAULT_GIVEAWAY_RULES, normalizeGiveawayStatus, type GiveawayStatus } from "./status";

export type GiveawayRow = {
  id: string;
  public_id: string;
  name?: string | null;
  description?: string | null;
  source: "csv" | "instagram";
  status: string;
  source_file_name: string | null;
  instagram_integration_id: string | null;
  instagram_media_id: string | null;
  instagram_media_permalink: string | null;
  instagram_media_caption: string | null;
  instagram_media_type?: string | null;
  instagram_thumbnail_url?: string | null;
  instagram_published_at?: string | null;
  imported_at: string | null;
  created_at: string;
  snapshot_frozen_at: string | null;
  current_winner_comment_id: string | null;
  current_draw_at: string | null;
  confirmed_winner_comment_id: string | null;
  confirmed_at: string | null;
  state?: {
    currentChecklist?: SorteioSession["currentChecklist"];
    disqualifications?: SorteioSession["disqualifications"];
    rules?: SorteioSession["rules"];
  } | null;
};

export type GiveawayEntryRow = {
  comment_id: string;
  entry_number: number;
  author_username: string;
  comment_text: string;
  mentions: unknown;
  comment_url: string | null;
  comment_created_at: string | null;
  status: "active" | "disqualified";
};

export type GiveawayAuditRow = {
  external_event_id: string;
  created_at: string;
  event_type: string;
  message: string;
  detail: string | null;
};

function mentionsFromRow(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [];
}

export function mapGiveawayEntry(row: GiveawayEntryRow): ParticipationEntry {
  const mentions = mentionsFromRow(row.mentions);
  return {
    entryNumber: Number(row.entry_number),
    commentId: String(row.comment_id),
    username: String(row.author_username),
    comment: String(row.comment_text),
    mentionsCount: mentions.length,
    mentions: mentions.join(" "),
    commentUrl: String(row.comment_url ?? ""),
    commentCreatedAt: row.comment_created_at ? String(row.comment_created_at) : null,
    chance: "1",
    status: row.status,
  };
}

export function sessionFromGiveawayRows(
  giveaway: GiveawayRow,
  entries: GiveawayEntryRow[],
  events: GiveawayAuditRow[],
): SorteioSession {
  const state = giveaway.state ?? {};
  return {
    databaseId: String(giveaway.id),
    id: String(giveaway.public_id),
    name: giveaway.name?.trim() || String(giveaway.public_id),
    description: giveaway.description ? String(giveaway.description) : null,
    createdAt: String(giveaway.created_at),
    importedFileName: giveaway.source_file_name,
    importedAt: giveaway.imported_at,
    entries: entries.map(mapGiveawayEntry),
    status: normalizeGiveawayStatus(giveaway.status) as SorteioSession["status"],
    currentWinnerCommentId: giveaway.current_winner_comment_id,
    currentDrawAt: giveaway.current_draw_at,
    currentChecklist: state.currentChecklist ?? { ...EMPTY_CHECKLIST },
    disqualifications: state.disqualifications ?? [],
    confirmedWinner: giveaway.confirmed_winner_comment_id
      ? { commentId: String(giveaway.confirmed_winner_comment_id), confirmedAt: String(giveaway.confirmed_at) }
      : null,
    history: events.map((event) => ({
      id: String(event.external_event_id),
      timestamp: String(event.created_at),
      type: event.event_type as SorteioSession["history"][number]["type"],
      message: String(event.message),
      detail: event.detail ? String(event.detail) : undefined,
    })),
    source: giveaway.source,
    instagramMediaId: giveaway.instagram_media_id,
    instagramMediaPermalink: giveaway.instagram_media_permalink,
    instagramMediaType: giveaway.instagram_media_type ?? null,
    instagramCaptionSnapshot: giveaway.instagram_media_caption ?? null,
    instagramThumbnailUrl: giveaway.instagram_thumbnail_url ?? null,
    instagramPublishedAt: giveaway.instagram_published_at ?? null,
    instagramIntegrationId: giveaway.instagram_integration_id,
    snapshotFrozenAt: giveaway.snapshot_frozen_at,
    rules: state.rules ?? { ...DEFAULT_GIVEAWAY_RULES },
  };
}

export function persistedGiveawayStatus(status: GiveawayStatus): GiveawayStatus {
  if (status === "empty") return "draft";
  if (status === "drawing") return "running";
  if (status === "finalized") return "completed";
  return status;
}
