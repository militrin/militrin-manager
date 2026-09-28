import type { OperationHistoryCategory, OperationHistoryItem } from "./types.ts";
import { shirtMatchesFilter } from "./shirt-from-audit.ts";

const DIACRITICS_PATTERN = /[\u0300-\u036f]/g;

export function normalizeHistorySearch(value: string) {
  return value.normalize("NFD").replace(DIACRITICS_PATTERN, "").toLowerCase().trim();
}

export function historyItemHaystack(item: OperationHistoryItem) {
  return normalizeHistorySearch(
    [
      item.title,
      item.participantName,
      item.ticketCode,
      item.orderNumber,
      item.operatorName,
      item.shirtLabel,
      item.wristbandLabel,
      item.reason,
      ...item.stateChanges.flatMap((change) => [change.label, change.previous, change.next]),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

export function itemMatchesSearch(item: OperationHistoryItem, rawQuery: string | null | undefined) {
  const query = normalizeHistorySearch(rawQuery ?? "");
  if (!query) return true;
  return historyItemHaystack(item).includes(query);
}

export function applyHistoryFilters(
  items: OperationHistoryItem[],
  filters: {
    category?: OperationHistoryCategory | "all" | null;
    operatorUserId?: string | null;
    search?: string | null;
    shirtType?: string | null;
    shirtSize?: string | null;
  },
) {
  const category = filters.category && filters.category !== "all" ? filters.category : null;
  const operatorUserId = filters.operatorUserId?.trim() || null;
  return items.filter((item) => {
    if (category && item.category !== category) return false;
    if (operatorUserId && item.actorUserId !== operatorUserId) return false;
    if (!shirtMatchesFilter(item, filters.shirtType, filters.shirtSize)) return false;
    return itemMatchesSearch(item, filters.search);
  });
}

export function countOperationCards(items: OperationHistoryItem[]) {
  let kitsDelivered = 0;
  let checkins = 0;
  let wristbands = 0;
  let corrections = 0;
  let manualIssues = 0;
  for (const item of items) {
    if (item.counts.kit) kitsDelivered += 1;
    if (item.counts.checkin) checkins += 1;
    if (item.counts.wristband) wristbands += 1;
    if (item.counts.correction) corrections += 1;
    if (item.counts.manualIssue) manualIssues += 1;
  }
  return {
    operations: items.length,
    kitsDelivered,
    checkins,
    wristbands,
    corrections,
    manualIssues,
  };
}
