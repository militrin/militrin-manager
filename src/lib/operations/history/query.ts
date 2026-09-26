import "server-only";

import { auditReasonFromDetails } from "@/lib/admin/audit-reason-label";
import { formatOperatorDisplayName } from "@/lib/admin/operator-display";
import { resolveOperatorNames } from "@/lib/admin/operator-names";
import { assertPermission, hasPermission } from "@/lib/admin/permissions";
import { ticketDisplayReference } from "@/lib/display-reference";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { canonicalHolderName } from "@/lib/tickets/holder-name";
import {
  FINANCIAL_AUDIT_ACTIONS,
  HISTORY_AUDIT_ACTIONS,
  HISTORY_HOLDER_OPERATIONS,
  PAGE_SIZE,
  RAW_FETCH_CAP,
  RAW_FETCH_CHUNK,
} from "./constants.ts";
import { foldOperationEvents } from "./fold-events.ts";
import { paginateByCursor } from "./paginate.ts";
import { periodToIsoBounds, resolveHistoryPeriod } from "./period.ts";
import { applyHistoryFilters, countOperationCards } from "./search.ts";
import type {
  OperationHistoryItem,
  OperationHistoryOperator,
  OperationHistoryQueryInput,
  OperationHistoryResponse,
  OperationRawEvent,
  OperationStateChange,
  OperationTechnicalDetails,
} from "./types.ts";

type Row = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function one(value: unknown): Row {
  if (Array.isArray(value)) return ((value[0] as Row | undefined) ?? {}) as Row;
  return value && typeof value === "object" ? value as Row : {};
}

function asString(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function chunkIds(ids: string[], size = 200) {
  const unique = [...new Set(ids.filter(Boolean))];
  const chunks: string[][] = [];
  for (let index = 0; index < unique.length; index += size) chunks.push(unique.slice(index, index + size));
  return chunks;
}

function sanitizeTechnicalDetails(item: OperationHistoryItem): OperationTechnicalDetails {
  return {
    grouping: item.grouping,
    sourceActions: item.sourceActions.filter((action) => !(FINANCIAL_AUDIT_ACTIONS as readonly string[]).includes(action)),
    sourceIds: item.sourceIds,
    ticketId: item.ticketId,
    actorUserId: item.actorUserId,
    entityType: item.entityType,
    entityId: item.entityId,
  };
}

function publicItem(item: OperationHistoryItem, canViewTechnical: boolean): OperationHistoryItem {
  const copy: OperationHistoryItem = {
    ...item,
    technical: canViewTechnical ? sanitizeTechnicalDetails(item) : null,
  };
  return copy;
}

async function fetchAuditRows(
  eventId: string,
  fromIso: string,
  toIso: string,
) {
  const auditLogsClient = createServiceRoleSupabaseClient();
  const rows: Row[] = [];
  let truncated = false;
  for (let offset = 0; offset < RAW_FETCH_CAP; offset += RAW_FETCH_CHUNK) {
    const to = Math.min(offset + RAW_FETCH_CHUNK - 1, RAW_FETCH_CAP - 1);
    const { data, error } = await auditLogsClient
      .from("audit_logs")
      .select("id,action,entity_type,entity_id,details,created_at")
      .eq("event_id", eventId)
      .in("action", [...HISTORY_AUDIT_ACTIONS])
      .gte("created_at", fromIso)
      .lte("created_at", toIso)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, to);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < RAW_FETCH_CHUNK) return { rows, truncated };
    if (rows.length >= RAW_FETCH_CAP) {
      truncated = true;
      return { rows: rows.slice(0, RAW_FETCH_CAP), truncated };
    }
  }
  return { rows, truncated };
}

async function fetchHolderRows(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  eventId: string,
  fromIso: string,
  toIso: string,
) {
  const rows: Row[] = [];
  let truncated = false;
  for (let offset = 0; offset < RAW_FETCH_CAP; offset += RAW_FETCH_CHUNK) {
    const to = Math.min(offset + RAW_FETCH_CHUNK - 1, RAW_FETCH_CAP - 1);
    const { data, error } = await supabase
      .from("ticket_holder_history")
      .select("id,ticket_id,operation,actor_user_id,actor_origin,reason,reason_code,reason_text,created_at,previous_participant_id,new_participant_id")
      .eq("event_id", eventId)
      .in("operation", [...HISTORY_HOLDER_OPERATIONS])
      .gte("created_at", fromIso)
      .lte("created_at", toIso)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, to);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < RAW_FETCH_CHUNK) return { rows, truncated };
    if (rows.length >= RAW_FETCH_CAP) {
      truncated = true;
      return { rows: rows.slice(0, RAW_FETCH_CAP), truncated };
    }
  }
  return { rows, truncated };
}

function toRawFromAudit(row: Row): OperationRawEvent | null {
  const action = asString(row.action);
  if (!action) return null;
  const details = one(row.details);
  const ticketId = asString(details.ticket_id) ?? (asString(row.entity_type) === "tickets" ? asString(row.entity_id) : null);
  return {
    id: `audit-${String(row.id)}`,
    occurredAt: String(row.created_at),
    action,
    source: "audit",
    ticketId,
    participantId: asString(details.participant_id),
    actorUserId: asString(details.actor_user_id),
    actorEmail: asString(details.actor_email),
    actorOrigin: asString(details.actor_origin),
    reason: auditReasonFromDetails(details),
    entityType: asString(row.entity_type),
    entityId: asString(row.entity_id),
    details,
    previousParticipantId: asString(details.previous_participant_id),
    nextParticipantId: asString(details.new_participant_id),
  };
}

function toRawFromHolder(row: Row): OperationRawEvent | null {
  const action = asString(row.operation);
  if (!action) return null;
  const details: Row = {
    reason: row.reason,
    reason_code: row.reason_code,
    reason_text: row.reason_text,
    previous_participant_id: row.previous_participant_id,
    new_participant_id: row.new_participant_id,
  };
  return {
    id: `holder-${String(row.id)}`,
    occurredAt: String(row.created_at),
    action,
    source: "holder",
    ticketId: asString(row.ticket_id),
    participantId: asString(row.new_participant_id) ?? asString(row.previous_participant_id),
    actorUserId: asString(row.actor_user_id),
    actorEmail: null,
    actorOrigin: asString(row.actor_origin),
    reason: auditReasonFromDetails(details),
    entityType: "ticket_holder_history",
    entityId: asString(row.id),
    details,
    previousParticipantId: asString(row.previous_participant_id),
    nextParticipantId: asString(row.new_participant_id),
  };
}

async function enrichItems(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  items: OperationHistoryItem[],
  rawById: Map<string, OperationRawEvent>,
  eventName: string,
) {
  const ticketIds = [...new Set(items.map((item) => item.ticketId).filter((value): value is string => Boolean(value)))];
  const ticketMap = new Map<string, Row>();
  const orderItemMap = new Map<string, Row>();
  const orderMap = new Map<string, Row>();
  const participantMap = new Map<string, string>();

  for (const ids of chunkIds(ticketIds)) {
    const { data: tickets } = await supabase.from("tickets").select("id,order_id,order_item_id,participant_id").in("id", ids);
    for (const ticket of tickets ?? []) ticketMap.set(String(ticket.id), ticket as Row);
  }

  const orderItemIds = [...new Set([...ticketMap.values()].map((ticket) => asString(ticket.order_item_id)).filter((value): value is string => Boolean(value)))];
  for (const ids of chunkIds(orderItemIds)) {
    const { data: orderItems } = await supabase
      .from("order_items")
      .select("id,order_id,participant_id,holder_full_name,shirt_type,shirt_size,item_position")
      .in("id", ids);
    for (const item of orderItems ?? []) orderItemMap.set(String(item.id), item as Row);
  }

  const orderIds = [...new Set([
    ...[...ticketMap.values()].map((ticket) => asString(ticket.order_id)).filter((value): value is string => Boolean(value)),
    ...[...orderItemMap.values()].map((item) => asString(item.order_id)).filter((value): value is string => Boolean(value)),
  ])];
  for (const ids of chunkIds(orderIds)) {
    const { data: orders } = await supabase.from("orders").select("id,display_number,order_number").in("id", ids);
    for (const order of orders ?? []) orderMap.set(String(order.id), order as Row);
  }

  const participantIds = [
    ...[...ticketMap.values()].map((ticket) => asString(ticket.participant_id)),
    ...[...orderItemMap.values()].map((item) => asString(item.participant_id)),
    ...items.flatMap((item) => {
      const raw = rawById.get(item.id);
      return [item.participantName, raw?.participantId, raw?.previousParticipantId, raw?.nextParticipantId];
    }),
    ...items.map((item) => {
      const ticket = item.ticketId ? ticketMap.get(item.ticketId) : null;
      return ticket ? asString(ticket.participant_id) : null;
    }),
  ].filter((value): value is string => Boolean(value) && UUID_RE.test(String(value)));

  for (const ids of chunkIds(participantIds)) {
    const { data: participants } = await supabase.from("participants").select("id,full_name").in("id", ids);
    for (const participant of participants ?? []) {
      const name = asString(participant.full_name);
      if (name) participantMap.set(String(participant.id), name);
    }
  }

  const actorIds = [...new Set(items.map((item) => item.actorUserId).filter((value): value is string => Boolean(value)))];
  const operatorNames = await resolveOperatorNames(actorIds);

  return items.map((item) => {
    const raw = rawById.get(item.id);
    const ticket = item.ticketId ? ticketMap.get(item.ticketId) : null;
    const orderItem = ticket?.order_item_id ? orderItemMap.get(String(ticket.order_item_id)) : null;
    const order = (ticket?.order_id ?? orderItem?.order_id) ? orderMap.get(String(ticket?.order_id ?? orderItem?.order_id)) : null;
    const resolvedParticipantId = asString(orderItem?.participant_id) ?? asString(ticket?.participant_id) ?? raw?.participantId ?? raw?.nextParticipantId;
    const participantName = canonicalHolderName(
      orderItem?.holder_full_name,
      resolvedParticipantId ? participantMap.get(resolvedParticipantId) : null,
      "",
    ) || null;

    const ticketCode = item.ticketId
      ? ticketDisplayReference(order?.display_number, orderItem?.item_position, order?.order_number)
      : null;
    const orderNumber = order
      ? ticketDisplayReference(order.display_number, null, order.order_number)
      : null;

    const shirtFromOrder = [asString(orderItem?.shirt_type), asString(orderItem?.shirt_size)].filter(Boolean).join(" ") || null;
    const operatorName = formatOperatorDisplayName({
      resolvedName: item.actorUserId ? operatorNames.get(item.actorUserId) : null,
      actorEmail: raw?.actorEmail,
      actorUserId: item.actorUserId,
      actorOrigin: raw?.actorOrigin,
    });

    const stateChanges: OperationStateChange[] = [...item.stateChanges];
    if ((item.category === "holders" || item.title.startsWith("TITULAR")) && raw) {
      const previous = raw.previousParticipantId ? participantMap.get(raw.previousParticipantId) ?? null : null;
      const next = raw.nextParticipantId ? participantMap.get(raw.nextParticipantId) ?? null : participantName;
      if (previous || next) {
        if (!stateChanges.some((change) => change.label === "Titular")) {
          stateChanges.push({ label: "Titular", previous, next });
        }
      }
    }

    const issuedWithoutHolder = item.counts.manualIssue && !participantName;
    return {
      ...item,
      eventName,
      participantName: issuedWithoutHolder ? "Sem titular" : participantName,
      ticketCode,
      orderNumber,
      operatorName,
      shirtLabel: item.shirtLabel ?? (item.category === "kit" ? shirtFromOrder : item.counts.manualIssue ? item.shirtLabel : null),
    };
  });
}

function operatorsFromItems(items: OperationHistoryItem[]): OperationHistoryOperator[] {
  const map = new Map<string, string>();
  for (const item of items) {
    if (!item.actorUserId) continue;
    if (!map.has(item.actorUserId) && item.operatorName && item.operatorName !== "Sistema") {
      map.set(item.actorUserId, item.operatorName);
    }
  }
  return [...map.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export async function queryOperationsHistory(input: OperationHistoryQueryInput): Promise<OperationHistoryResponse> {
  await assertPermission("operations.view_report");
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) return { success: false, message: "Selecione uma organização." };
  if (!UUID_RE.test(input.eventId)) return { success: false, message: "Evento inválido." };

  const period = resolveHistoryPeriod({
    period: input.period,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
  });
  const { fromIso, toIso } = periodToIsoBounds(period.dateFrom, period.dateTo);
  const supabase = await createServerSupabaseClient();
  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id,name")
    .eq("id", input.eventId)
    .eq("organization_id", organization.id)
    .maybeSingle();
  if (eventError) return { success: false, message: eventError.message };
  if (!event) return { success: false, message: "Evento não encontrado nesta organização." };

  try {
    const [audit, holders] = await Promise.all([
      fetchAuditRows(event.id, fromIso, toIso),
      fetchHolderRows(supabase, event.id, fromIso, toIso),
    ]);
    const raw: OperationRawEvent[] = [];
    for (const row of audit.rows) {
      const eventRow = toRawFromAudit(row);
      if (eventRow) raw.push(eventRow);
    }
    for (const row of holders.rows) {
      const eventRow = toRawFromHolder(row);
      if (eventRow) raw.push(eventRow);
    }

    const rawById = new Map(raw.map((eventRow) => [eventRow.id, eventRow]));
    const folded = foldOperationEvents(raw);
    const enriched = await enrichItems(supabase, folded, rawById, String(event.name));
    const filtered = applyHistoryFilters(enriched, {
      category: input.category,
      operatorUserId: input.operatorUserId,
      search: input.search,
    });
    const page = paginateByCursor(filtered, input.cursor, input.pageSize ?? PAGE_SIZE);
    const canViewTechnical = input.includeTechnical === false ? false : await hasPermission("audit.view");
    const operators = operatorsFromItems(enriched);

    return {
      success: true,
      eventId: event.id,
      eventName: String(event.name),
      dateFrom: period.dateFrom,
      dateTo: period.dateTo,
      period: input.period,
      cards: countOperationCards(filtered),
      items: page.items.map((item) => publicItem(item, canViewTechnical)),
      operators,
      nextCursor: page.nextCursor,
      truncated: audit.truncated || holders.truncated,
      generatedAt: new Date().toISOString(),
      canViewTechnical,
    };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Não foi possível carregar o histórico." };
  }
}
