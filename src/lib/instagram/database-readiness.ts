export type PostgrestErrorLike = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

const GIVEAWAY_RELATIONS = [
  "giveaways",
  "giveaway_entries",
  "giveaway_audit_events",
  "instagram_integrations",
] as const;

export function isMissingGiveawaySchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as PostgrestErrorLike;
  if (candidate.code !== "PGRST205" && candidate.code !== "42P01") return false;
  const description = `${candidate.message ?? ""} ${candidate.details ?? ""} ${candidate.hint ?? ""}`.toLowerCase();
  return GIVEAWAY_RELATIONS.some((relation) => description.includes(relation));
}

export function resolveOptionalGiveawaySchema<T>(data: T, error: unknown) {
  if (!error) return { databaseReady: true as const, data };
  if (isMissingGiveawaySchemaError(error)) return { databaseReady: false as const, data: null };
  throw error;
}
