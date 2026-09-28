import { getShirtSizeOrder, getShirtTypeOrder } from "../../constants/shirts.ts";
import type { OperationHistoryItem, OperationRawEvent, ShirtDeliveryStatus } from "./types.ts";

function text(details: Record<string, unknown> | null | undefined, ...keys: string[]) {
  if (!details) return null;
  for (const key of keys) {
    const value = String(details[key] ?? "").trim();
    if (value) return value;
  }
  return null;
}

export function normalizeHistoricalShirtType(value: string | null | undefined) {
  return String(value ?? "").trim();
}

export function normalizeHistoricalShirtSize(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

export function formatHistoricalShirtLabel(type: string | null | undefined, size: string | null | undefined) {
  const parts = [normalizeHistoricalShirtType(type), normalizeHistoricalShirtSize(size)].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

export function parseShirtFromDetails(details: Record<string, unknown> | null | undefined) {
  const type = text(details, "shirt_type", "new_shirt_type", "next_type", "new_type", "variant_name");
  const size = text(details, "shirt_size", "new_shirt_size", "next_size", "new_size", "variant_value");
  const previousType = text(details, "previous_shirt_type", "previous_type");
  const previousSize = text(details, "previous_shirt_size", "previous_size");
  const variantId = text(details, "variant_id", "new_variant_id");
  const previousVariantId = text(details, "previous_variant_id");
  const quantityRaw = Number(details?.quantity);
  return {
    type: normalizeHistoricalShirtType(type) || null,
    size: normalizeHistoricalShirtSize(size) || null,
    label: formatHistoricalShirtLabel(type, size),
    previousType: normalizeHistoricalShirtType(previousType) || null,
    previousSize: normalizeHistoricalShirtSize(previousSize) || null,
    previousLabel: formatHistoricalShirtLabel(previousType, previousSize),
    variantId,
    previousVariantId,
    quantity: Number.isFinite(quantityRaw) && quantityRaw > 0 ? quantityRaw : null,
  };
}

export function variantIdsFromRaw(raw: OperationRawEvent) {
  const parsed = parseShirtFromDetails(raw.details);
  return [parsed.variantId, parsed.previousVariantId].filter((value): value is string => Boolean(value));
}

export function shirtMatchesFilter(
  item: Pick<OperationHistoryItem, "shirtLabel" | "stateChanges">,
  shirtType?: string | null,
  shirtSize?: string | null,
) {
  const wantedType = normalizeHistoricalShirtType(shirtType);
  const wantedSize = normalizeHistoricalShirtSize(shirtSize);
  if (!wantedType && !wantedSize) return true;

  const labels = [
    item.shirtLabel,
    ...item.stateChanges.filter((change) => change.label === "Camiseta").flatMap((change) => [change.previous, change.next]),
  ];
  return labels.some((label) => {
    const parsed = splitShirtLabel(label);
    if (wantedType && parsed.type.toLowerCase() !== wantedType.toLowerCase()) return false;
    if (wantedSize && parsed.size !== wantedSize) return false;
    return Boolean(parsed.type || parsed.size);
  });
}

export function splitShirtLabel(label: string | null | undefined) {
  const trimmed = String(label ?? "").trim();
  if (!trimmed) return { type: "", size: "" };
  const parts = trimmed.split(/\s+/);
  const size = normalizeHistoricalShirtSize(parts[parts.length - 1]);
  const type = parts.slice(0, -1).join(" ");
  if (parts.length === 1) return { type: trimmed, size: "" };
  return { type, size };
}

export function isKitDeliveryItem(item: Pick<OperationHistoryItem, "counts" | "title">) {
  return Boolean(item.counts.kit) || /^KIT ENTREGUE/.test(item.title);
}

export function isKitUndoItem(item: Pick<OperationHistoryItem, "counts" | "title">) {
  return Boolean(item.counts.correction) && /ENTREGA DE (KIT|ITEM) DESFEITA/.test(item.title);
}

export function pickPriorDeliveryShirt(
  undo: Pick<OperationHistoryItem, "ticketId" | "occurredAt">,
  deliveries: Array<{ ticketId: string; occurredAt: string; label: string | null }>,
) {
  if (!undo.ticketId) return null;
  const prior = deliveries
    .filter((delivery) => delivery.ticketId === undo.ticketId && delivery.occurredAt <= undo.occurredAt && delivery.label)
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
  return prior[0]?.label ?? null;
}

export function inheritUndoShirtFromPriorDeliveries(
  items: OperationHistoryItem[],
  deliveries: Array<{ ticketId: string; occurredAt: string; label: string | null }>,
) {
  return items.map((item) => {
    if (!isKitUndoItem(item) || item.shirtLabel || !item.ticketId) return item;
    const label = pickPriorDeliveryShirt(item, deliveries);
    return label ? { ...item, shirtLabel: label } : item;
  });
}

export function annotateKitDeliveryLifecycle(items: OperationHistoryItem[]): OperationHistoryItem[] {
  const byTicket = new Map<string, OperationHistoryItem[]>();
  for (const item of items) {
    if (!item.ticketId || (!isKitDeliveryItem(item) && !isKitUndoItem(item))) continue;
    const list = byTicket.get(item.ticketId) ?? [];
    list.push(item);
    byTicket.set(item.ticketId, list);
  }

  const statusById = new Map<string, ShirtDeliveryStatus>();
  const inheritedShirtById = new Map<string, string>();
  for (const group of byTicket.values()) {
    const chronological = [...group].sort((a, b) => {
      if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    let cycleShirt: string | null = null;
    let sawUndo = false;
    for (const item of chronological) {
      if (isKitDeliveryItem(item)) {
        cycleShirt = item.shirtLabel;
        statusById.set(item.id, sawUndo ? "redelivered" : "delivered");
      } else if (isKitUndoItem(item)) {
        sawUndo = true;
        statusById.set(item.id, "undone");
        if (!item.shirtLabel && cycleShirt) inheritedShirtById.set(item.id, cycleShirt);
      }
    }
  }

  return items.map((item) => ({
    ...item,
    deliveryStatus: statusById.get(item.id) ?? item.deliveryStatus ?? null,
    shirtLabel: item.shirtLabel ?? inheritedShirtById.get(item.id) ?? null,
  }));
}

export function countShirtDeliverySummary(items: OperationHistoryItem[]) {
  let periodDeliveries = 0;
  let periodUndos = 0;
  let unknownSize = 0;
  for (const item of items) {
    if (isKitDeliveryItem(item)) {
      periodDeliveries += 1;
      if (!item.shirtLabel) unknownSize += 1;
    } else if (isKitUndoItem(item)) {
      periodUndos += 1;
      if (!item.shirtLabel) unknownSize += 1;
    }
  }
  return { periodDeliveries, periodUndos, unknownSize };
}

export function sortShirtCatalog(types: string[], sizesByType: Record<string, string[]>) {
  const sortedTypes = [...types].sort((a, b) => {
    const rank = getShirtTypeOrder(a) - getShirtTypeOrder(b);
    return rank !== 0 ? rank : a.localeCompare(b, "pt-BR");
  });
  const sortedSizes: Record<string, string[]> = {};
  for (const type of sortedTypes) {
    sortedSizes[type] = [...(sizesByType[type] ?? [])].sort((a, b) => {
      const rank = getShirtSizeOrder(a) - getShirtSizeOrder(b);
      return rank !== 0 ? rank : a.localeCompare(b, "pt-BR");
    });
  }
  return { types: sortedTypes, sizesByType: sortedSizes };
}

export function deliveryStatusLabel(status: ShirtDeliveryStatus | null | undefined) {
  if (status === "delivered") return "ENTREGUE";
  if (status === "undone") return "DESFEITA";
  if (status === "redelivered") return "REENTREGUE";
  return null;
}

export function shirtDeliveriesHeading(type?: string | null, size?: string | null) {
  const label = formatHistoricalShirtLabel(type, size);
  return label ? `Entregas — ${label}` : "Entregas de camiseta";
}
