/** Nome canônico do titular: texto livre em `order_items.holder_full_name`. */
export function canonicalHolderName(
  holderFullName?: unknown,
  fallbackParticipantName?: unknown,
  emptyLabel = "Titular não definido",
) {
  const primary = String(holderFullName ?? "").trim();
  if (primary) return primary;
  const fallback = String(fallbackParticipantName ?? "").trim();
  if (fallback) return fallback;
  return emptyLabel;
}

export function hasCanonicalHolderName(holderFullName?: unknown) {
  return Boolean(String(holderFullName ?? "").trim());
}
