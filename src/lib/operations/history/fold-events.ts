import {
  ACTION_CHECKIN,
  ACTION_CHECKIN_UNDO,
  ACTION_COMBINED_KIT_CHECKIN,
  ACTION_KIT_DELIVERED,
  ACTION_KIT_DELIVERY_UNDONE,
  ACTION_KIT_ITEM_DELIVERED,
  ACTION_KIT_ITEM_UNDONE,
  CANONICAL_ABSORB_WINDOW_MS,
  COMBINED_CHECKIN_WINDOW_MS,
  LEGACY_GROUP_WINDOW_MS,
} from "./constants.ts";
import { compareOccurredDesc } from "./paginate.ts";
import type {
  OperationCounts,
  OperationGrouping,
  OperationHistoryCategory,
  OperationHistoryItem,
  OperationRawEvent,
  OperationStateChange,
} from "./types.ts";

function occurredMs(value: string) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function withinWindow(a: OperationRawEvent, b: OperationRawEvent, windowMs: number) {
  return Math.abs(occurredMs(a.occurredAt) - occurredMs(b.occurredAt)) <= windowMs;
}

function sameTicket(a: OperationRawEvent, b: OperationRawEvent) {
  return Boolean(a.ticketId && b.ticketId && a.ticketId === b.ticketId);
}

function sameActor(a: OperationRawEvent, b: OperationRawEvent) {
  return Boolean(a.actorUserId && b.actorUserId && a.actorUserId === b.actorUserId);
}

function text(details: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = String(details[key] ?? "").trim();
    if (value) return value;
  }
  return null;
}

export function maskWristbandCode(code: string | null | undefined) {
  const value = String(code ?? "").trim();
  if (!value) return null;
  const tail = value.slice(-4);
  return tail ? `••••${tail}` : null;
}

function shirtFromDetails(details: Record<string, unknown>) {
  const type = text(details, "shirt_type");
  const size = text(details, "shirt_size");
  const joined = [type, size].filter(Boolean).join(" ");
  return joined || null;
}

function wristbandFromDetails(details: Record<string, unknown>) {
  return maskWristbandCode(text(details, "wristband_code", "code", "new_wristband_code"));
}

function emptyCounts(overrides: Partial<OperationCounts> = {}): OperationCounts {
  return {
    kit: false,
    checkin: false,
    wristband: false,
    correction: false,
    manualIssue: false,
    ...overrides,
  };
}

function baseItem(
  seed: OperationRawEvent,
  members: OperationRawEvent[],
  input: {
    title: string;
    category: OperationHistoryCategory;
    grouping: OperationGrouping;
    counts: OperationCounts;
    stateChanges?: OperationStateChange[];
    shirtLabel?: string | null;
    wristbandLabel?: string | null;
  },
): OperationHistoryItem {
  const newest = [...members, seed].sort(compareOccurredDesc)[0] ?? seed;
  return {
    id: seed.id,
    occurredAt: newest.occurredAt,
    title: input.title,
    category: input.category,
    grouping: input.grouping,
    participantName: null,
    ticketCode: null,
    orderNumber: null,
    operatorName: "",
    shirtLabel: input.shirtLabel ?? shirtFromDetails(seed.details),
    wristbandLabel: input.wristbandLabel ?? wristbandFromDetails(seed.details),
    reason: seed.reason ?? members.map((member) => member.reason).find(Boolean) ?? null,
    eventName: "",
    stateChanges: input.stateChanges ?? [],
    counts: input.counts,
    actorUserId: seed.actorUserId,
    ticketId: seed.ticketId,
    sourceActions: [...new Set([seed.action, ...members.map((member) => member.action)])],
    sourceIds: [seed.id, ...members.map((member) => member.id)],
    entityType: seed.entityType,
    entityId: seed.entityId,
  };
}

function absorbNearby(
  events: OperationRawEvent[],
  seed: OperationRawEvent,
  used: Set<string>,
  options: {
    actions: Set<string>;
    windowMs: number;
    requireSameActor?: boolean;
    accept?: (event: OperationRawEvent) => boolean;
  },
) {
  const taken: OperationRawEvent[] = [];
  for (const event of events) {
    if (used.has(event.id) || event.id === seed.id) continue;
    if (!options.actions.has(event.action)) continue;
    if (!sameTicket(seed, event)) continue;
    if (options.requireSameActor && !sameActor(seed, event)) continue;
    if (!withinWindow(seed, event, options.windowMs)) continue;
    if (options.accept && !options.accept(event)) continue;
    taken.push(event);
  }
  return taken;
}

function greedyLegacyGroup(
  events: OperationRawEvent[],
  seed: OperationRawEvent,
  used: Set<string>,
  action: string,
  windowMs: number,
) {
  const group = [seed];
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of events) {
      if (used.has(event.id) || event.action !== action) continue;
      if (!sameTicket(seed, event) || !sameActor(seed, event)) continue;
      const close = group.some((member) => withinWindow(member, event, windowMs));
      if (!close) continue;
      used.add(event.id);
      group.push(event);
      changed = true;
    }
  }
  return group;
}

function kitStateChanges(members: OperationRawEvent[]) {
  const shirt = members.map((member) => shirtFromDetails(member.details)).find(Boolean) ?? null;
  return shirt ? [{ label: "Camiseta", previous: null, next: shirt }] : [];
}

function wristbandStateChanges(event: OperationRawEvent): OperationStateChange[] {
  const previous = maskWristbandCode(text(event.details, "old_wristband_code", "previous_code"));
  const next = maskWristbandCode(text(event.details, "new_wristband_code", "wristband_code", "code"));
  if (!previous && !next) return [];
  return [{ label: "Pulseira", previous, next }];
}

function shirtStateChanges(event: OperationRawEvent): OperationStateChange[] {
  const previous = [text(event.details, "previous_type"), text(event.details, "previous_size")].filter(Boolean).join(" ") || null;
  const next = [text(event.details, "next_type", "shirt_type", "new_type"), text(event.details, "next_size", "shirt_size", "new_size")].filter(Boolean).join(" ") || null;
  if (!previous && !next) return [];
  return [{ label: "Camiseta", previous, next }];
}

function issueKindLabel(details: Record<string, unknown>) {
  const reason = (text(details, "issue_reason", "reason_code") ?? "").toLowerCase();
  if (reason.includes("courtesy") || reason.includes("cortesia") || reason === "administrative_adjustment") {
    return "Cortesia";
  }
  if (reason.includes("correction") || reason === "issuance_error") return "Correção";
  if (reason.includes("system")) return "Falha de sistema";
  return null;
}

function presentSingle(event: OperationRawEvent): OperationHistoryItem {
  switch (event.action) {
    case ACTION_CHECKIN:
      return baseItem(event, [], {
        title: "CHECK-IN REALIZADO",
        category: "checkin",
        grouping: "single",
        counts: emptyCounts({ checkin: true }),
      });
    case ACTION_CHECKIN_UNDO:
      return baseItem(event, [], {
        title: "CHECK-IN DESFEITO",
        category: "checkin",
        grouping: "single",
        counts: emptyCounts({ correction: true }),
      });
    case "wristband_linked":
      return baseItem(event, [], {
        title: "PULSEIRA VINCULADA",
        category: "wristbands",
        grouping: "single",
        counts: emptyCounts({ wristband: true }),
        wristbandLabel: wristbandFromDetails(event.details),
        stateChanges: wristbandStateChanges(event),
      });
    case "wristband_replaced":
      return baseItem(event, [], {
        title: "PULSEIRA SUBSTITUÍDA",
        category: "wristbands",
        grouping: "single",
        counts: emptyCounts({ wristband: false, correction: true }),
        wristbandLabel: wristbandFromDetails(event.details),
        stateChanges: wristbandStateChanges(event),
      });
    case "wristband_unlinked":
      return baseItem(event, [], {
        title: "PULSEIRA DESVINCULADA",
        category: "wristbands",
        grouping: "single",
        counts: emptyCounts({ correction: true }),
        stateChanges: wristbandStateChanges(event),
      });
    case "wristband_blocked":
      return baseItem(event, [], {
        title: "PULSEIRA BLOQUEADA",
        category: "wristbands",
        grouping: "single",
        counts: emptyCounts({ correction: true }),
        stateChanges: wristbandStateChanges(event),
      });
    case "holder_changed":
    case "ticket_transferred":
      return baseItem(event, [], {
        title: "TITULAR ALTERADO",
        category: "holders",
        grouping: "single",
        counts: emptyCounts({ correction: true }),
      });
    case "holder_assigned":
      return baseItem(event, [], {
        title: "TITULAR DEFINIDO",
        category: "holders",
        grouping: "single",
        counts: emptyCounts({ correction: true }),
      });
    case "holder_removed":
      return baseItem(event, [], {
        title: "TITULAR REMOVIDO",
        category: "holders",
        grouping: "single",
        counts: emptyCounts({ correction: true }),
      });
    case "manual_ticket_issued":
    case "manual_registration_order_created":
    case "manual_unassigned_ticket_order_created":
      return baseItem(event, [], {
        title: "INGRESSO EMITIDO",
        category: "tickets",
        grouping: "single",
        counts: emptyCounts({ manualIssue: true }),
        shirtLabel: issueKindLabel(event.details),
      });
    case "store_order_item_delivered":
      return baseItem(event, [], {
        title: "ITEM ADICIONAL ENTREGUE",
        category: "store",
        grouping: "single",
        counts: emptyCounts(),
      });
    case "store_order_item_delivery_undone":
      return baseItem(event, [], {
        title: "ENTREGA ADICIONAL DESFEITA",
        category: "store",
        grouping: "single",
        counts: emptyCounts({ correction: true }),
      });
    case "store_item_admin_granted":
      return baseItem(event, [], {
        title: "ITEM ADICIONAL CONCEDIDO",
        category: "store",
        grouping: "single",
        counts: emptyCounts({ correction: true }),
      });
    case "ticket_shirt_admin_changed":
    case "ticket_shirt_admin_corrected_after_operation":
      return baseItem(event, [], {
        title: event.action === "ticket_shirt_admin_corrected_after_operation" ? "CAMISETA CORRIGIDA" : "CAMISETA ALTERADA",
        category: "kit",
        grouping: "single",
        counts: emptyCounts({ correction: true }),
        stateChanges: shirtStateChanges(event),
      });
    case ACTION_KIT_ITEM_UNDONE:
      return baseItem(event, [], {
        title: "ENTREGA DE ITEM DESFEITA",
        category: "kit",
        grouping: "legacy",
        counts: emptyCounts({ correction: true }),
      });
    case ACTION_KIT_ITEM_DELIVERED:
      return baseItem(event, [], {
        title: "KIT ENTREGUE",
        category: "kit",
        grouping: "legacy",
        counts: emptyCounts({ kit: true }),
      });
    default:
      return baseItem(event, [], {
        title: event.action.replaceAll("_", " ").toUpperCase(),
        category: "kit",
        grouping: "single",
        counts: emptyCounts(),
      });
  }
}

function kitTitle(hasCheckin: boolean) {
  return hasCheckin ? "KIT ENTREGUE + CHECK-IN" : "KIT ENTREGUE";
}

/**
 * Precedência: evento canônico > combined > agrupamento legado.
 * Não altera logs; só a apresentação/contagem.
 */
export function foldOperationEvents(raw: OperationRawEvent[]): OperationHistoryItem[] {
  const used = new Set<string>();
  const events = [...raw].sort(compareOccurredDesc);
  const folded: OperationHistoryItem[] = [];
  const ticketsWithCanonicalKit = new Set(
    events.filter((event) => event.action === ACTION_KIT_DELIVERED && event.ticketId).map((event) => event.ticketId as string),
  );
  const ticketsWithCountedCheckin = new Set<string>();
  const ticketsWithCanonicalUndo = new Set(
    events.filter((event) => event.action === ACTION_KIT_DELIVERY_UNDONE && event.ticketId).map((event) => event.ticketId as string),
  );

  for (const seed of events) {
    if (seed.action !== ACTION_KIT_DELIVERED || used.has(seed.id)) continue;
    const nearby = absorbNearby(events, seed, used, {
      actions: new Set([ACTION_KIT_ITEM_DELIVERED, ACTION_COMBINED_KIT_CHECKIN, ACTION_CHECKIN]),
      windowMs: CANONICAL_ABSORB_WINDOW_MS,
    });
    const hasCombined = nearby.some((event) => event.action === ACTION_COMBINED_KIT_CHECKIN);
    const members = nearby.filter((event) => {
      if (event.action !== ACTION_CHECKIN) return true;
      if (hasCombined) return true;
      return sameActor(seed, event) && withinWindow(seed, event, COMBINED_CHECKIN_WINDOW_MS);
    });
    used.add(seed.id);
    for (const member of members) used.add(member.id);
    const hasCheckin = hasCombined || members.some((event) => event.action === ACTION_CHECKIN);
    if (hasCheckin && seed.ticketId) ticketsWithCountedCheckin.add(seed.ticketId);
    folded.push(baseItem(seed, members, {
      title: kitTitle(hasCheckin),
      category: "kit",
      grouping: "canonical",
      counts: emptyCounts({ kit: true, checkin: hasCheckin }),
      shirtLabel: shirtFromDetails(seed.details) ?? members.map((member) => shirtFromDetails(member.details)).find(Boolean) ?? null,
      stateChanges: kitStateChanges([seed, ...members]),
    }));
  }

  for (const seed of events) {
    if (seed.action !== ACTION_COMBINED_KIT_CHECKIN || used.has(seed.id)) continue;
    const members = absorbNearby(events, seed, used, {
      actions: new Set([ACTION_KIT_ITEM_DELIVERED, ACTION_CHECKIN]),
      windowMs: CANONICAL_ABSORB_WINDOW_MS,
    });
    used.add(seed.id);
    for (const member of members) used.add(member.id);
    const alreadyCountedKit = Boolean(seed.ticketId && ticketsWithCanonicalKit.has(seed.ticketId));
    const alreadyCountedCheckin = Boolean(seed.ticketId && ticketsWithCountedCheckin.has(seed.ticketId));
    if (alreadyCountedKit && alreadyCountedCheckin) continue;
    if (seed.ticketId && !alreadyCountedCheckin) ticketsWithCountedCheckin.add(seed.ticketId);
    folded.push(baseItem(seed, members, {
      title: alreadyCountedKit ? "CHECK-IN REALIZADO" : kitTitle(true),
      category: alreadyCountedKit ? "checkin" : "kit",
      grouping: "combined",
      counts: emptyCounts({ kit: !alreadyCountedKit, checkin: !alreadyCountedCheckin }),
    }));
  }

  for (const seed of events) {
    if (seed.action !== ACTION_KIT_ITEM_DELIVERED || used.has(seed.id)) continue;
    used.add(seed.id);
    const group = greedyLegacyGroup(events, seed, used, ACTION_KIT_ITEM_DELIVERED, LEGACY_GROUP_WINDOW_MS);
    const nearbyCombined = absorbNearby(events, seed, used, {
      actions: new Set([ACTION_COMBINED_KIT_CHECKIN, ACTION_CHECKIN]),
      windowMs: LEGACY_GROUP_WINDOW_MS,
      requireSameActor: true,
    }).filter((event) => event.action !== ACTION_COMBINED_KIT_CHECKIN || !used.has(event.id));
    // Combined leftovers already processed; only absorb unused check-in sitting next to a legacy kit group.
    const checkins = nearbyCombined.filter((event) => event.action === ACTION_CHECKIN);
    for (const member of checkins) used.add(member.id);
    folded.push(baseItem(seed, [...group.slice(1), ...checkins], {
      title: kitTitle(checkins.length > 0),
      category: "kit",
      grouping: "legacy",
      counts: emptyCounts({ kit: true, checkin: checkins.length > 0 }),
    }));
  }

  for (const seed of events) {
    if (seed.action !== ACTION_KIT_DELIVERY_UNDONE || used.has(seed.id)) continue;
    const members = absorbNearby(events, seed, used, {
      actions: new Set([ACTION_KIT_ITEM_UNDONE]),
      windowMs: CANONICAL_ABSORB_WINDOW_MS,
    });
    used.add(seed.id);
    for (const member of members) used.add(member.id);
    folded.push(baseItem(seed, members, {
      title: "ENTREGA DE KIT DESFEITA",
      category: "kit",
      grouping: "canonical",
      counts: emptyCounts({ correction: true }),
    }));
  }

  for (const seed of events) {
    if (seed.action !== ACTION_KIT_ITEM_UNDONE || used.has(seed.id)) continue;
    if (seed.ticketId && ticketsWithCanonicalUndo.has(seed.ticketId)) {
      // Undo canônico do mesmo ingresso no período: itens restantes não viram outra correção de kit.
      const nearbyCanonical = events.some((event) =>
        event.action === ACTION_KIT_DELIVERY_UNDONE
        && sameTicket(seed, event)
        && withinWindow(seed, event, CANONICAL_ABSORB_WINDOW_MS),
      );
      if (nearbyCanonical) {
        used.add(seed.id);
        continue;
      }
    }
    used.add(seed.id);
    const group = greedyLegacyGroup(events, seed, used, ACTION_KIT_ITEM_UNDONE, LEGACY_GROUP_WINDOW_MS);
    folded.push(baseItem(seed, group.slice(1), {
      title: "ENTREGA DE KIT DESFEITA",
      category: "kit",
      grouping: "legacy",
      counts: emptyCounts({ correction: true }),
    }));
  }

  for (const event of events) {
    if (used.has(event.id)) continue;
    used.add(event.id);
    folded.push(presentSingle(event));
  }

  return folded.sort(compareOccurredDesc);
}
