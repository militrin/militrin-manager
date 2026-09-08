export const GIVEAWAY_STATUSES = [
  "empty",
  "draft",
  "preparing",
  "ready",
  "drawing",
  "running",
  "awaiting_validation",
  "finalized",
  "completed",
  "cancelled",
] as const;

export type GiveawayStatus = (typeof GIVEAWAY_STATUSES)[number];

export type GiveawayHubSection = "drafts" | "in_progress" | "finished";

export function isGiveawayStatus(value: string): value is GiveawayStatus {
  return (GIVEAWAY_STATUSES as readonly string[]).includes(value);
}

export function normalizeGiveawayStatus(status: string): GiveawayStatus {
  return isGiveawayStatus(status) ? status : "draft";
}

export function giveawayHubSection(status: string): GiveawayHubSection {
  const normalized = normalizeGiveawayStatus(status);
  if (normalized === "draft" || normalized === "empty" || normalized === "preparing") return "drafts";
  if (normalized === "finalized" || normalized === "completed" || normalized === "cancelled") return "finished";
  return "in_progress";
}

export function giveawayStatusLabel(status: string) {
  switch (normalizeGiveawayStatus(status)) {
    case "empty":
    case "draft":
      return "Rascunho";
    case "preparing":
      return "Preparando";
    case "ready":
      return "Pronto";
    case "drawing":
    case "running":
      return "Sorteando";
    case "awaiting_validation":
      return "Aguardando validação";
    case "finalized":
    case "completed":
      return "Finalizado";
    case "cancelled":
      return "Cancelado";
  }
}

export function isDraftLikeStatus(status: string) {
  const normalized = normalizeGiveawayStatus(status);
  return normalized === "empty" || normalized === "draft" || normalized === "preparing";
}

export function isReadyStatus(status: string) {
  return normalizeGiveawayStatus(status) === "ready";
}

export function isDrawingStatus(status: string) {
  const normalized = normalizeGiveawayStatus(status);
  return normalized === "drawing" || normalized === "running";
}

export function isAwaitingValidationStatus(status: string) {
  return normalizeGiveawayStatus(status) === "awaiting_validation";
}

export function isCompletedStatus(status: string) {
  const normalized = normalizeGiveawayStatus(status);
  return normalized === "finalized" || normalized === "completed";
}

export function isSnapshotMutableStatus(status: string) {
  const normalized = normalizeGiveawayStatus(status);
  return normalized === "empty" || normalized === "draft" || normalized === "preparing" || normalized === "ready";
}

export function canChangeGiveawayPost(status: string, snapshotFrozenAt: string | null) {
  return snapshotFrozenAt == null && isDraftLikeStatus(status);
}

export function canSyncGiveawayComments(status: string, snapshotFrozenAt: string | null) {
  if (snapshotFrozenAt) return false;
  const normalized = normalizeGiveawayStatus(status);
  return normalized === "draft" || normalized === "preparing" || normalized === "ready" || normalized === "empty";
}

export function canImportGiveawayCsv(status: string, snapshotFrozenAt: string | null) {
  return snapshotFrozenAt == null && isSnapshotMutableStatus(status);
}

export const DEFAULT_GIVEAWAY_RULES = {
  chancePerComment: 1,
  minMentions: 0,
} as const;
