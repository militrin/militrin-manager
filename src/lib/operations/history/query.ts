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
  KIT_HISTORY_AUDIT_ACTIONS,
  PAGE_SIZE,
  RAW_FETCH_CAP,
  RAW_FETCH_CHUNK,
} from "./constants.ts";
import { foldOperationEvents } from "./fold-events.ts";
import { paginateByCursor } from "./paginate.ts";
import { periodToIsoBounds, resolveHistoryPeriod } from "./period.ts";
import { applyHistoryFilters, countOperationCards } from "./search.ts";
import {
  annotateKitDeliveryLifecycle,
  countShirtDeliverySummary,
  formatHistoricalShirtLabel,
  inheritUndoShirtFromPriorDeliveries,
  isKitUndoItem,
  parseShirtFromDetails,
  sortShirtCatalog,
  variantIdsFromRaw,
} from "./shirt-from-audit.ts";
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
  actions: readonly string[] = HISTORY_AUDIT_ACTIONS,
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
      .in("action", [...actions])
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
      .select("id,order_id,participant_id,holder_full_name,registration_contact_id,item_position")
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
      orderId: asString(ticket?.order_id) ?? asString(orderItem?.order_id) ?? asString(order?.id),
      contactId: asString(orderItem?.registration_contact_id),
      operatorName,
      shirtLabel: item.shirtLabel,
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

function shouldNarrowToKitHistory(input: OperationHistoryQueryInput) {
  return Boolean(input.shirtType?.trim() || input.shirtSize?.trim() || input.category === "kit");
}

async function loadVariantLabelsByIds(ids: string[]) {
  const labels = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return labels;
  const auditLogsClient = createServiceRoleSupabaseClient();
  for (const chunk of chunkIds(unique)) {
    const { data } = await auditLogsClient
      .from("event_kit_item_variants")
      .select("id,name,value")
      .in("id", chunk);
    for (const row of data ?? []) {
      const label = formatHistoricalShirtLabel(asString((row as Row).name), asString((row as Row).value));
      if (label) labels.set(String((row as Row).id), label);
    }
  }
  return labels;
}

async function resolveVariantLabels(raw: OperationRawEvent[]) {
  return loadVariantLabelsByIds(raw.flatMap((event) => variantIdsFromRaw(event)));
}

function applyVariantLabels(
  items: OperationHistoryItem[],
  rawById: Map<string, OperationRawEvent>,
  variantLabels: Map<string, string>,
) {
  return items.map((item) => {
    if (item.shirtLabel) return item;
    const sources = [rawById.get(item.id), ...item.sourceIds.map((id) => rawById.get(id))].filter(Boolean) as OperationRawEvent[];
    for (const raw of sources) {
      const parsed = parseShirtFromDetails(raw.details);
      const fromVariant = parsed.variantId ? variantLabels.get(parsed.variantId) : null;
      if (fromVariant || parsed.label) {
        return { ...item, shirtLabel: parsed.label ?? fromVariant ?? null };
      }
    }
    return item;
  });
}

async function backfillUndoShirtFromPriorDeliveries(
  eventId: string,
  items: OperationHistoryItem[],
) {
  const missing = items.filter((item) => isKitUndoItem(item) && !item.shirtLabel && item.ticketId);
  const ticketIds = [...new Set(missing.map((item) => item.ticketId).filter((value): value is string => typeof value === "string" && UUID_RE.test(value)))];
  if (!ticketIds.length) return items;
  const auditLogsClient = createServiceRoleSupabaseClient();
  const deliveries: Array<{ ticketId: string; occurredAt: string; label: string | null; variantId: string | null }> = [];
  for (const chunk of chunkIds(ticketIds)) {
    const [{ data: canonical }, { data: itemLogs }] = await Promise.all([
      auditLogsClient
        .from("audit_logs")
        .select("entity_id,details,created_at")
        .eq("event_id", eventId)
        .eq("action", "kit_delivered")
        .in("entity_id", chunk)
        .order("created_at", { ascending: false }),
      auditLogsClient
        .from("audit_logs")
        .select("details,created_at")
        .eq("event_id", eventId)
        .eq("action", "ticket_kit_item_delivered")
        .filter("details->>ticket_id", "in", `(${chunk.join(",")})`)
        .order("created_at", { ascending: false }),
    ]);
    for (const row of [...(canonical ?? []), ...(itemLogs ?? [])]) {
      const details = one((row as Row).details);
      const ticketId = asString(details.ticket_id) ?? asString((row as Row).entity_id);
      const parsed = parseShirtFromDetails(details);
      if (!ticketId) continue;
      deliveries.push({
        ticketId,
        occurredAt: String((row as Row).created_at),
        label: parsed.label,
        variantId: parsed.variantId,
      });
    }
  }
  const variantIds = [...new Set(deliveries.map((row) => row.variantId).filter((value): value is string => Boolean(value)))];
  const variantLabels = await loadVariantLabelsByIds(variantIds);
  const resolved = deliveries.map((row) => ({
    ticketId: row.ticketId,
    occurredAt: row.occurredAt,
    label: row.label ?? (row.variantId ? variantLabels.get(row.variantId) ?? null : null),
  }));
  return inheritUndoShirtFromPriorDeliveries(items, resolved);
}

async function loadShirtCatalog(eventId: string) {
  const auditLogsClient = createServiceRoleSupabaseClient();
  const { data } = await auditLogsClient
    .from("event_kit_items")
    .select("event_kit_item_variants(name,value,is_active)")
    .eq("event_id", eventId)
    .eq("item_type", "shirt");
  const sizesByType: Record<string, string[]> = {};
  for (const item of data ?? []) {
    const variants = Array.isArray((item as Row).event_kit_item_variants)
      ? (item as Row).event_kit_item_variants as Row[]
      : [];
    for (const row of variants) {
      if (row.is_active === false) continue;
      const type = asString(row.name);
      const size = asString(row.value)?.toUpperCase() ?? null;
      if (!type || !size) continue;
      if (!sizesByType[type]) sizesByType[type] = [];
      if (!sizesByType[type].includes(size)) sizesByType[type].push(size);
    }
  }
  return sortShirtCatalog(Object.keys(sizesByType), sizesByType);
}

async function loadCurrentlyDelivered(eventId: string, shirtType: string | null, shirtSize: string | null) {
  if (!shirtType || !shirtSize) return null;
  const auditLogsClient = createServiceRoleSupabaseClient();
  const { data } = await auditLogsClient
    .from("event_kit_item_variant_inventory")
    .select("delivered_quantity,event_kit_item_variants!inner(name,value)")
    .eq("event_id", eventId);
  let total = 0;
  let found = false;
  for (const row of data ?? []) {
    const relation = Array.isArray((row as Row).event_kit_item_variants)
      ? ((row as Row).event_kit_item_variants as Row[])[0]
      : (row as Row).event_kit_item_variants as Row | null;
    const type = asString(relation?.name);
    const size = asString(relation?.value)?.toUpperCase() ?? null;
    if (type?.toLowerCase() !== shirtType.toLowerCase() || size !== shirtSize.toUpperCase()) continue;
    found = true;
    total += Number((row as Row).delivered_quantity ?? 0);
  }
  return found ? total : null;
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
    const kitOnly = shouldNarrowToKitHistory(input);
    const [audit, holders, shirtCatalog] = await Promise.all([
      fetchAuditRows(event.id, fromIso, toIso, kitOnly ? KIT_HISTORY_AUDIT_ACTIONS : HISTORY_AUDIT_ACTIONS),
      kitOnly ? Promise.resolve({ rows: [] as Row[], truncated: false }) : fetchHolderRows(supabase, event.id, fromIso, toIso),
      loadShirtCatalog(event.id),
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
    const variantLabels = await resolveVariantLabels(raw);
    const folded = applyVariantLabels(foldOperationEvents(raw), rawById, variantLabels);
    const sameWindowLifecycle = annotateKitDeliveryLifecycle(folded);
    const withPriorUndoShirt = await backfillUndoShirtFromPriorDeliveries(event.id, sameWindowLifecycle);
    const enriched = await enrichItems(supabase, withPriorUndoShirt, rawById, String(event.name));
    const annotated = annotateKitDeliveryLifecycle(enriched);
    const filtered = applyHistoryFilters(annotated, {
      category: input.category,
      operatorUserId: input.operatorUserId,
      search: input.search,
      shirtType: input.shirtType,
      shirtSize: input.shirtSize,
    });
    const page = paginateByCursor(filtered, input.cursor, input.pageSize ?? PAGE_SIZE);
    const [canViewTechnical, canViewCadastro, canViewOrderPermission, currentlyDelivered] = await Promise.all([
      input.includeTechnical === false ? Promise.resolve(false) : hasPermission("audit.view"),
      hasPermission("participants.view"),
      hasPermission("orders.view"),
      input.shirtType && input.shirtSize
        ? loadCurrentlyDelivered(event.id, input.shirtType, input.shirtSize)
        : Promise.resolve(null),
    ]);
    const canViewTicket = canViewCadastro || canViewOrderPermission;
    const canViewOrder = canViewCadastro;
    const operators = operatorsFromItems(annotated);
    const shirtFilterActive = Boolean(input.shirtType?.trim() || input.shirtSize?.trim());
    const summaryCounts = countShirtDeliverySummary(filtered);

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
      shirtCatalog,
      shirtDeliverySummary: shirtFilterActive
        ? { ...summaryCounts, currentlyDelivered }
        : null,
      canViewCadastro,
      canViewTicket,
      canViewOrder,
      nextCursor: page.nextCursor,
      truncated: audit.truncated || holders.truncated,
      generatedAt: new Date().toISOString(),
      canViewTechnical,
    };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Não foi possível carregar o histórico." };
  }
}
