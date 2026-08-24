import { jsPDF } from "jspdf";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { deduplicateTicketTimelineEvents, loadOptionalTimelineSource } from "@/lib/admin/ticket-timeline-query";
import { timelineActionDefinition, timelineTypeOptions, type TimelineCategory, type TimelineScope, type TimelineTypeOption } from "@/lib/admin/ticket-event-taxonomy";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { getTimelineStateLabel, isCanonicalTimelineState } from "@/lib/status-labels";
import { applyReportPage, finalizeReportPages, formatReportDateTime, reportIsoDateTime, REPORT_THEME, splitTechnicalIdentifier } from "@/lib/reports/report-theme";
import { sensitiveActionReasonLabel } from "@/lib/admin/sensitive-action-reasons";
import { orderDisplayReference, ticketDisplayReference } from "@/lib/display-reference";

type Supabase = Awaited<ReturnType<typeof createServerSupabaseClient>>;
type Row = Record<string, unknown>;

export type TicketTimelineEvent = {
  id: string;
  occurredAt: string;
  type: string;
  label: string;
  previousState: string | null;
  newState: string | null;
  operator: string;
  reason: string | null;
  detail: string | null;
  observation?: string | null;
  description?: string;
  category?: TimelineCategory;
  eventId?: string | null;
  relatedTicketId?: string | null;
  relatedOrderId?: string | null;
  source: "functional" | "audit";
  hasTransition?: boolean;
};

export type TicketTimelineHeader = {
  ticketId: string;
  ticketReference: string;
  eventName: string;
  orderNumber: string;
  holderName: string;
  status: string;
  organizationId: string;
  eventId: string;
  filteredEventName: string | null;
};

export type TicketTimelineResult = {
  header: TicketTimelineHeader;
  events: TicketTimelineEvent[];
  total: number;
  page: number;
  pageSize: number;
  availableTypes: TimelineTypeOption[];
  hasPartialHistory: boolean;
  scope: TimelineScope;
  appliedEventId: string | null;
  appliedTypeCode: string | null;
  appliedTypeLabel: string | null;
  technicalEvents: TicketTimelineEvent[];
  technicalEventCount: number;
  canViewTechnicalAudit: boolean;
  availableEvents: Array<{ id: string; name: string }>;
  generatedAt: string;
};

export type TicketTimelineFilters = { from?: string; to?: string; type?: string; scope?: TimelineScope; eventId?: string; page?: number; pageSize?: number; canViewTechnicalAudit?: boolean };

function actionLabel(action: string, fallback: string) {
  return timelineActionDefinition(action)?.label ?? fallback;
}

function one(value: unknown): Row | null {
  if (Array.isArray(value)) return (value[0] as Row | undefined) ?? null;
  return value && typeof value === "object" ? value as Row : null;
}

function maskEmail(value: unknown) {
  const email = String(value ?? ""); const at = email.indexOf("@");
  return at > 0 ? `${email.slice(0, 2)}***@${email.slice(at + 1)}` : null;
}

function operatorFrom(details: Row, actor: unknown, operatorNames?: Map<string,string>) {
  const masked = maskEmail(details.actor_email);
  if (masked) return masked;
  if (details.actor_origin === "portal") return "Titular autenticado";
  const resolvedName = operatorNames?.get(String(details.actor_user_id ?? ""));
  if (resolvedName) return resolvedName;
  if (details.actor_user_id) return "Operador administrativo";
  return String(actor ?? "Sistema");
}

function state(details: Row, keys: string[]) {
  for (const key of keys) if (details[key] !== null && details[key] !== undefined && details[key] !== "") return String(details[key]);
  return null;
}

function safeDetail(action: string, details: Row, variants: Map<string,string>) {
  if (action.includes("shirt")) {
    const resolvedNew = variants.get(String(details.new_variant_id ?? details.variant_id ?? ""));
    if (resolvedNew) return `Alterada para ${resolvedNew}`;
    const type = state(details, ["next_type", "shirt_type", "variant_name"]);
    const size = state(details, ["next_size", "shirt_size", "variant_value"]);
    return [type, size].filter(Boolean).join(" / ") || variants.get(String(details.variant_id ?? "")) || null;
  }
  if (action.includes("exported")) return state(details, ["format"]);
  if (action.includes("kit")) return state(details, ["item_name", "kit_item_id"]);
  return null;
}

export async function getAdministrativeTicketTimeline(supabase: Supabase, ticketId: string, organizationId: string, filters: TicketTimelineFilters = {}): Promise<TicketTimelineResult> {
  const warnings: string[] = [];
  const scope: TimelineScope = filters.scope === "account" ? "account" : "ticket";
  let appliedEventId: string | null = null;
  let filteredEventName: string | null = null;
  if (scope === "account" && filters.eventId) {
    const { data: selectedEvent, error: selectedEventError } = await createServiceRoleSupabaseClient().from("events").select("id,name").eq("id", filters.eventId).eq("organization_id", organizationId).maybeSingle();
    if (!selectedEventError && selectedEvent) { appliedEventId = selectedEvent.id; filteredEventName = selectedEvent.name; }
    else console.warn("[ticket-timeline:invalid-event-filter]", JSON.stringify({ source: "account-timeline", code: selectedEventError?.code ?? "INVALID_EVENT_ID", organizationId, eventIdKind: "unrecognized" }));
  }
  const ticketResult = await supabase.from("tickets").select("id,status,issued_at,used_at,cancelled_at,event_id,organization_id,owner_user_id,participant_id,order_id,order_item_id")
    .eq("id", ticketId).eq("organization_id", organizationId).maybeSingle();
  if (ticketResult.error) throw ticketResult.error;
  if (!ticketResult.data) throw new Error("Ingresso não encontrado ou sem acesso à organização.");
  const ticket = ticketResult.data as Row;
  const orderItem = ticket.order_item_id ? one(await loadOptionalTimelineSource("order-item", supabase.from("order_items").select("id,order_id,participant_id,event_id,item_position").eq("id", String(ticket.order_item_id)).eq("event_id", String(ticket.event_id)).maybeSingle(), ticketId, warnings)) : null;
  const canonicalOrderId = orderItem?.order_id ?? ticket.order_id;
  const order = canonicalOrderId ? one(await loadOptionalTimelineSource("order", supabase.from("orders").select("id,order_number,display_number,confirmed_at,payment_id,event_id,organization_id").eq("id", String(canonicalOrderId)).eq("event_id", String(ticket.event_id)).eq("organization_id", organizationId).maybeSingle(), ticketId, warnings)) : null;
  const payment = order?.payment_id ? one(await loadOptionalTimelineSource("payment", supabase.from("payments").select("id,paid_at,payment_status,event_id,organization_id").eq("id", String(order.payment_id)).eq("event_id", String(ticket.event_id)).eq("organization_id", organizationId).maybeSingle(), ticketId, warnings)) : null;
  const participant = ticket.participant_id ? one(await loadOptionalTimelineSource("participant", supabase.from("participants").select("id,user_id,full_name,event_id,organization_id").eq("id", String(ticket.participant_id)).eq("event_id", String(ticket.event_id)).eq("organization_id", organizationId).maybeSingle(), ticketId, warnings)) : null;
  const event = one(await loadOptionalTimelineSource("event", supabase.from("events").select("id,name,organization_id").eq("id", String(ticket.event_id)).eq("organization_id", organizationId).maybeSingle(), ticketId, warnings));
  const kitRows = await loadOptionalTimelineSource("kit-links", supabase.from("participant_kit_items").select("id").eq("ticket_id", ticketId), ticketId, warnings) ?? [];
  const entityIds = [ticketId, ticket.participant_id, canonicalOrderId, ticket.order_item_id, order?.payment_id, ...kitRows.map((item) => item.id)].filter(Boolean).map(String);
  const protectedAuditResult = await supabase.rpc("get_admin_ticket_audit_timeline", { p_ticket_id: ticketId });
  let auditRows: Row[] | null = null;
  if (!protectedAuditResult.error) {
    auditRows = (protectedAuditResult.data ?? []) as Row[];
    console.info("[ticket-timeline:audit-rpc]", JSON.stringify({ ticketId, source: "protected-rpc", rowCount: auditRows.length }));
  } else {
    console.error("[ticket-timeline:audit-rpc]", JSON.stringify({ ticketId, source: "protected-rpc", code: protectedAuditResult.error.code, message: protectedAuditResult.error.message }));
  }
  if (auditRows === null) {
    auditRows = await loadOptionalTimelineSource("audit-logs", supabase.from("audit_logs").select("id,action,entity_type,entity_id,event_id,details,created_at").eq("event_id", String(ticket.event_id)).in("entity_id", entityIds).order("created_at", { ascending: true }).limit(1000), ticketId, warnings);
    console.info("[ticket-timeline:audit-logs]", JSON.stringify({ ticketId, source: "authenticated-postgrest", rowCount: auditRows?.length ?? 0 }));
  }
  if ((auditRows?.length ?? 0) === 0) {
    console.error("[ticket-timeline:audit-logs]", JSON.stringify({ ticketId, source: "authenticated-postgrest", code: "EMPTY_AUDIT_SOURCE", message: "A consulta autenticada não retornou os eventos de auditoria do ingresso." }));
    if (!warnings.includes("audit-logs")) warnings.push("audit-logs");
  }
  if (scope === "account" && participant?.user_id) {
    try {
      const admin = createServiceRoleSupabaseClient();
      const { data: accountParticipants, error: participantsError } = await admin.from("participants").select("id").eq("user_id", String(participant.user_id)).eq("organization_id", organizationId);
      if (participantsError) throw participantsError;
      const participantIds = (accountParticipants ?? []).map((row) => row.id);
      const { data: accountTickets, error: ticketsError } = await admin.from("tickets").select("id,order_id,order_item_id,event_id").eq("organization_id", organizationId).in("participant_id", participantIds);
      if (ticketsError) throw ticketsError;
      const ticketIds = (accountTickets ?? []).map((row) => row.id);
      const orderIds = (accountTickets ?? []).map((row) => row.order_id).filter(Boolean);
      const orderItemIds = (accountTickets ?? []).map((row) => row.order_item_id).filter(Boolean);
      const { data: accountOrders, error: ordersError } = orderIds.length ? await admin.from("orders").select("id,payment_id").eq("organization_id", organizationId).in("id", orderIds) : { data: [], error: null };
      if (ordersError) throw ordersError;
      const paymentIds = (accountOrders ?? []).map((row) => row.payment_id).filter(Boolean);
      const accountEntityIds = [...new Set([...participantIds, ...ticketIds, ...orderIds, ...orderItemIds, ...paymentIds])];
      let accountAuditQuery = admin.from("audit_logs").select("id,action,entity_type,entity_id,event_id,details,created_at").in("entity_id", accountEntityIds).order("created_at", { ascending: true }).limit(5000);
      if (appliedEventId) accountAuditQuery = accountAuditQuery.eq("event_id", appliedEventId);
      const { data: accountAudits, error: accountAuditError } = await accountAuditQuery;
      if (accountAuditError) throw accountAuditError;
      const merged = new Map<string, Row>();
      for (const row of [...(auditRows ?? []), ...(accountAudits ?? [])]) merged.set(String(row.id), row as Row);
      auditRows = [...merged.values()];
      console.info("[ticket-timeline:account-audit]", JSON.stringify({ ticketId, source: "server-scoped-account-read", rowCount: auditRows.length }));
    } catch (error) {
      console.error("[ticket-timeline:account-audit]", JSON.stringify({ ticketId, source: "server-scoped-account-read", code: "ACCOUNT_AUDIT_FAILED", message: error instanceof Error ? error.message : "Falha desconhecida" }));
      warnings.push("account-audit");
    }
  }
  const [holderRows, ownerRows, requestRows] = await Promise.all([
    loadOptionalTimelineSource("holder-history", supabase.from("ticket_holder_history").select("id,operation,previous_participant_id,new_participant_id,previous_registration_contact_id,new_registration_contact_id,previous_user_id,new_user_id,actor_user_id,actor_origin,reason,reason_code,reason_text,created_at").eq("ticket_id", ticketId).eq("organization_id", organizationId).order("created_at", { ascending: true }).limit(500), ticketId, warnings),
    loadOptionalTimelineSource("owner-history", supabase.from("ticket_owner_history").select("id,operation,previous_owner_user_id,new_owner_user_id,actor_user_id,reason_code,reason_text,created_at").eq("ticket_id",ticketId).eq("organization_id",organizationId).order("created_at",{ascending:true}).limit(500),ticketId,warnings),
    loadOptionalTimelineSource("item-change-requests", supabase.from("ticket_item_change_requests").select("id,status,current_variant,requested_variant,requested_at,reviewed_at,reason,review_notes").eq("ticket_id", ticketId).eq("organization_id", organizationId).order("requested_at", { ascending: true }).limit(500), ticketId, warnings),
  ]);
  const variantIds = [...new Set((auditRows ?? []).flatMap((row) => ["variant_id", "previous_variant_id", "new_variant_id"].map((key) => String((one(row.details) ?? {})[key] ?? ""))).filter(Boolean))];
  const variantRows = variantIds.length ? await loadOptionalTimelineSource("variants", supabase.from("event_kit_item_variants").select("id,name,value").in("id",variantIds), ticketId, warnings) ?? [] : [];
  const variants = new Map(variantRows.map((variant) => [String(variant.id), `${String(variant.name)} / ${String(variant.value)}`]));
  const operatorNames = new Map<string,string>();
  const actorIds = [...new Set([...(holderRows ?? []).map((row)=>String(row.actor_user_id ?? "")),...(ownerRows??[]).flatMap((row)=>[row.actor_user_id,row.previous_owner_user_id,row.new_owner_user_id].map((value)=>String(value??""))),...(filters.canViewTechnicalAudit ? (auditRows ?? []).map((row) => String((one(row.details) ?? {}).actor_user_id ?? "")) : [])].filter(Boolean))];
  if (actorIds.length) {
    const { data: profiles } = await createServiceRoleSupabaseClient().from("customer_profiles").select("user_id,full_name").in("user_id", actorIds);
    for (const profile of profiles ?? []) if (profile.full_name) operatorNames.set(profile.user_id, profile.full_name);
  }
  const holderParticipantIds=[...new Set((holderRows ?? []).flatMap((row)=>[row.previous_participant_id,row.new_participant_id]).filter(Boolean).map(String))];
  const holderNames=new Map<string,string>();
  if(holderParticipantIds.length){
    const {data:holderParticipants}=await createServiceRoleSupabaseClient().from("participants").select("id,full_name").in("id",holderParticipantIds);
    for(const holderParticipant of holderParticipants ?? []) if(holderParticipant.full_name) holderNames.set(holderParticipant.id,holderParticipant.full_name);
  }

  const events: TicketTimelineEvent[] = [];
  const technicalEvents: TicketTimelineEvent[] = [];
  if (ticket.issued_at) events.push({ id: `issued-${ticketId}`, occurredAt: String(ticket.issued_at), type: "ticket_issued", label: actionLabel("ticket_issued", "Ingresso emitido"), description: "O ingresso foi emitido.", previousState: null, newState: null, operator: "Sistema", reason: null, detail: null, eventId: String(ticket.event_id), relatedTicketId: ticketId, relatedOrderId: String(canonicalOrderId ?? "") || null, source: "functional" });
  if (payment?.paid_at ?? order?.confirmed_at) events.push({ id: `paid-${order?.payment_id ?? ticket.order_id}`, occurredAt: String(payment?.paid_at ?? order?.confirmed_at), type: "payment_confirmed", label: "Pagamento confirmado", description: "O pagamento associado foi confirmado.", previousState: "pending", newState: String(payment?.payment_status ?? "paid"), operator: "Sistema", reason: null, detail: null, eventId: String(ticket.event_id), relatedTicketId: ticketId, relatedOrderId: String(canonicalOrderId ?? "") || null, source: "functional" });
  if (ticket.used_at) events.push({ id: `used-${ticketId}`, occurredAt: String(ticket.used_at), type: "ticket_checkin_entry", label: actionLabel("ticket_checkin_entry", "Check-in realizado"), description: "O ingresso foi utilizado no check-in.", previousState: "active", newState: "used", operator: "Sistema", reason: null, detail: null, eventId: String(ticket.event_id), relatedTicketId: ticketId, relatedOrderId: String(canonicalOrderId ?? "") || null, source: "functional" });
  if (ticket.cancelled_at) events.push({ id: `cancelled-${ticketId}`, occurredAt: String(ticket.cancelled_at), type: "admin_ticket_cancelled", label: actionLabel("admin_ticket_cancelled", "Ingresso cancelado"), description: "O ingresso foi cancelado administrativamente.", previousState: "active", newState: "cancelled", operator: "Sistema", reason: null, detail: null, eventId: String(ticket.event_id), relatedTicketId: ticketId, relatedOrderId: String(canonicalOrderId ?? "") || null, source: "functional" });

  for (const row of auditRows ?? []) {
    const details = one(row.details) ?? {};
    const action = String(row.action);
    const definition = timelineActionDefinition(action);
    const detail = safeDetail(action, details, variants);
    const baseEvent: TicketTimelineEvent = { id: `audit-${row.id}`, occurredAt: String(row.created_at), type: action, label: definition?.label ?? action, description: definition?.description ?? "Registro técnico de auditoria.", category: definition?.category, previousState: definition?.previousKeys ? state(details, definition.previousKeys) : null, newState: definition?.nextKeys ? state(details, definition.nextKeys) : null, operator: operatorFrom(details, null, operatorNames), reason: state(details, ["reason", "review_notes"]), detail, eventId: row.event_id ? String(row.event_id) : null, relatedTicketId: String(details.ticket_id ?? (row.entity_type === "tickets" ? row.entity_id : "")) || null, relatedOrderId: String(details.order_id ?? "") || null, source: "audit" };
    if (!definition) { technicalEvents.push(baseEvent); continue; }
    if (!definition.scopes.includes(scope)) continue;
    if (action === "ticket_shirt_admin_changed" && detail) {
      baseEvent.label = `Camiseta alterada para ${detail.replace(/^Alterada para /, "")}`;
      if (!details.previous_variant_id) { baseEvent.previousState = null; baseEvent.newState = null; }
    }
    events.push(baseEvent);
  }
  for (const row of holderRows ?? []) {
    const action = String(row.operation);
    const previousName=row.previous_participant_id ? holderNames.get(String(row.previous_participant_id)) ?? "Titular anterior" : "Titular não definido";
    const newName=row.new_participant_id ? holderNames.get(String(row.new_participant_id)) ?? "Novo titular" : "Titular não definido";
    events.push({ id: `holder-${row.id}`, occurredAt: String(row.created_at), type: action, label: actionLabel(action, "Titularidade atualizada"), description: action === "holder_removed" ? "O ingresso ficou sem titular." : "A titularidade do ingresso foi atualizada.", previousState: previousName, newState: newName, hasTransition:true, operator: row.actor_origin === "portal" ? "Titular autenticado" : operatorNames.get(String(row.actor_user_id ?? "")) ?? "Operador administrativo", reason: sensitiveActionReasonLabel(row.reason_code) ?? (row.reason ? "Motivo legado" : null), observation: row.reason_text ? String(row.reason_text) : row.reason ? String(row.reason) : null, detail: null, eventId: String(ticket.event_id), relatedTicketId: ticketId, relatedOrderId: String(canonicalOrderId ?? "") || null, source: "functional" });
  }
  for(const row of ownerRows??[]){
    const previous=row.previous_owner_user_id?operatorNames.get(String(row.previous_owner_user_id))??"Proprietário anterior":"Proprietário não definido";
    const next=operatorNames.get(String(row.new_owner_user_id))??"Novo proprietário";
    events.push({id:`owner-${row.id}`,occurredAt:String(row.created_at),type:String(row.operation),label:actionLabel(String(row.operation),"Propriedade atualizada"),description:"A conta proprietária atual do ingresso foi alterada.",previousState:previous,newState:next,hasTransition:true,operator:operatorNames.get(String(row.actor_user_id))??"Operador administrativo",reason:sensitiveActionReasonLabel(row.reason_code),observation:row.reason_text?String(row.reason_text):null,detail:null,eventId:String(ticket.event_id),relatedTicketId:ticketId,relatedOrderId:String(canonicalOrderId??"")||null,source:"functional"});
  }
  for (const row of requestRows ?? []) {
    const current = one(row.current_variant); const requested = one(row.requested_variant);
    events.push({ id: `request-${row.id}`, occurredAt: String(row.requested_at), type: "ticket_item_change_requested", label: actionLabel("ticket_item_change_requested", "Alteração de item solicitada"), previousState: state(current ?? {}, ["name", "value"]), newState: state(requested ?? {}, ["name", "value"]), operator: "Titular autenticado", reason: row.reason, detail: null, source: "functional" });
    if (row.reviewed_at && row.status !== "pending") { const action = `ticket_item_change_${row.status}`; events.push({ id: `review-${row.id}`, occurredAt: String(row.reviewed_at), type: action, label: actionLabel(action, "Alteração de item revisada"), previousState: "pending", newState: String(row.status), operator: "Operador administrativo", reason: row.review_notes, detail: null, source: "functional" }); }
  }

  const localizeStates = (item: TicketTimelineEvent): TicketTimelineEvent => {
    if(item.hasTransition===true) return item;
    const hasTransition = isCanonicalTimelineState(item.previousState) && isCanonicalTimelineState(item.newState);
    return { ...item, hasTransition,
      previousState: item.previousState ? getTimelineStateLabel(item.previousState, { eventType: item.type, field: "previousState" }) : null,
      newState: item.newState ? getTimelineStateLabel(item.newState, { eventType: item.type, field: "newState" }) : null,
    };
  };
  const normalized = deduplicateTicketTimelineEvents(events).map(localizeStates);
  const localizedTechnicalEvents = technicalEvents.map(localizeStates);
  const typeContextEvents = normalized.filter((item) => !appliedEventId || item.eventId === appliedEventId);
  const technicalTypesAvailable = localizedTechnicalEvents.some((item) => !appliedEventId || item.eventId === appliedEventId);
  const availableTypes = timelineTypeOptions(typeContextEvents.map((item) => item.type), Boolean(filters.canViewTechnicalAudit && technicalTypesAvailable));
  const appliedType = filters.type ? availableTypes.find((option) => option.code === filters.type) : undefined;
  const appliedTypeCode = appliedType?.code ?? null;
  const appliedTypeLabel = appliedType?.label ?? null;
  const technicalFilterSelected = appliedTypeCode === "__technical__";
  const matchesFilters = (item: TicketTimelineEvent) => (!filters.from || item.occurredAt >= filters.from) && (!filters.to || item.occurredAt <= `${filters.to}T23:59:59.999Z`) && (!appliedTypeCode || appliedTypeCode === "__technical__" || item.type === appliedTypeCode) && (!appliedEventId || item.eventId === appliedEventId);
  const filtered = technicalFilterSelected ? [] : normalized.filter(matchesFilters);
  const filteredTechnical = localizedTechnicalEvents.filter((item) => matchesFilters(item) && (!appliedTypeCode || appliedTypeCode === "__technical__"));
  const timelineEventIds = [...new Set([...normalized, ...localizedTechnicalEvents].map((item) => item.eventId).filter((id): id is string => Boolean(id)))];
  let availableEvents: Array<{ id: string; name: string }> = [];
  if (timelineEventIds.length) {
    const { data: eventOptions } = await createServiceRoleSupabaseClient().from("events").select("id,name").eq("organization_id", organizationId).in("id", timelineEventIds).order("name");
    availableEvents = (eventOptions ?? []).map((item) => ({ id: item.id, name: item.name }));
  }
  const pageSize = Math.min(5000, Math.max(10, filters.pageSize ?? 25)); const page = Math.max(1, filters.page ?? 1); const start = (page - 1) * pageSize;
  return { header: { ticketId, ticketReference: ticketDisplayReference(order?.display_number, orderItem?.item_position ?? 1, order?.order_number), eventName: String(event?.name ?? "Evento"), filteredEventName, orderNumber: orderDisplayReference(order?.display_number, order?.order_number), holderName: String(participant?.full_name ?? "Sem titular"), status: getTimelineStateLabel(String(ticket.status), { eventType: "ticket_header", field: "status" }) ?? "Estado não informado", organizationId, eventId: String(ticket.event_id) }, events: filtered.slice(start, start + pageSize), total: technicalFilterSelected ? filteredTechnical.length : filtered.length, page, pageSize, availableTypes, hasPartialHistory: warnings.length > 0, scope, appliedEventId, appliedTypeCode, appliedTypeLabel, technicalEvents: filters.canViewTechnicalAudit ? filteredTechnical : [], technicalEventCount: filteredTechnical.length, canViewTechnicalAudit: Boolean(filters.canViewTechnicalAudit), availableEvents, generatedAt: new Date().toISOString() };
}

export function ticketTimelineToCsv(result: TicketTimelineResult, generatedAt: string, generatedBy: string) {
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const contextRows = result.scope === "account"
    ? [["Escopo", "Conta inteira"], ["Filtro de evento", result.appliedEventId ? result.header.filteredEventName ?? "Evento filtrado" : "Todos os eventos"], ["Filtro de tipo", result.appliedTypeLabel ?? "Todos os tipos"], ["Conta de", result.header.holderName]]
    : [["Escopo", "Este ingresso"], ["Filtro de tipo", result.appliedTypeLabel ?? "Todos os tipos"], ["Ingresso", result.header.ticketId], ["Evento", result.header.eventName], ["Pedido", result.header.orderNumber], ["Titular", result.header.holderName], ["Status", result.header.status]];
  const rows = [...contextRows, ["Gerado em (ISO)", reportIsoDateTime(generatedAt)], ["Gerado em (Brasil)", formatReportDateTime(generatedAt)], ["Fuso horário", "America/Sao_Paulo"], ["Responsável", generatedBy], [], ["Data/hora ISO", "Data/hora (Brasil)", "Código do tipo", "Tipo", "Descrição", "Estado anterior", "Estado novo", "Operador", "Motivo", "Alteração", "Evento ID", "Ingresso ID", "Pedido ID"]];
  const exportedEvents = result.canViewTechnicalAudit ? [...result.events, ...result.technicalEvents] : result.events;
  for (const item of exportedEvents) rows.push([reportIsoDateTime(item.occurredAt), formatReportDateTime(item.occurredAt), item.type, item.label, item.description ?? "", item.hasTransition ? item.previousState ?? "" : "", item.hasTransition ? item.newState ?? "" : "", item.operator, item.reason ?? "", item.detail ?? "", item.eventId ?? "", item.relatedTicketId ?? "", item.relatedOrderId ?? ""]);
  return `\uFEFF${rows.map((row) => row.map(escape).join(";")).join("\r\n")}`;
}

export function ticketTimelineToPdf(result: TicketTimelineResult, generatedAt: string, generatedBy: string) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const { page, colors } = REPORT_THEME;
  const contentWidth = page.width - (page.marginX * 2);
  let y = 65;
  const addPage = () => { doc.addPage(); applyReportPage(doc, "Histórico administrativo do ingresso"); y = 65; };
  applyReportPage(doc, "Histórico administrativo do ingresso");
  doc.setFillColor(...colors.card); doc.setDrawColor(...colors.border); doc.roundedRect(page.marginX, y, contentWidth, result.scope === "ticket" ? 118 : 88, 5, 5, "FD");
  doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...colors.muted);
  const contextLines = result.scope === "account"
    ? [["Escopo", "Conta inteira"], ["Evento", result.appliedEventId ? result.header.filteredEventName ?? "Evento filtrado" : "Todos os eventos"], ["Tipo", result.appliedTypeLabel ?? "Todos os tipos"], ["Conta de", result.header.holderName]]
    : [["Escopo", "Este ingresso"], ["Evento", result.header.eventName], ["Titular", result.header.holderName], ["Status", result.header.status]];
  contextLines.forEach(([label, value], index) => { doc.setFont("helvetica", "bold"); doc.text(`${label}:`, page.marginX + 12, y + 18 + (index * 17)); doc.setFont("helvetica", "normal"); doc.text(String(value), page.marginX + 76, y + 18 + (index * 17)); });
  if (result.scope === "ticket") {
    doc.setFillColor(...colors.greenSoft); doc.roundedRect(page.marginX + 292, y + 12, 191, 35, 4, 4, "F");
    doc.setTextColor(...colors.green); doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("Pedido", page.marginX + 304, y + 27); doc.setFontSize(13); doc.text(result.header.orderNumber, page.marginX + 304, y + 42);
    doc.setTextColor(...colors.muted); doc.setFont("courier", "normal"); doc.setFontSize(8);
    doc.text("Identificação técnica", page.marginX + 304, y + 64);
    doc.text(splitTechnicalIdentifier(result.header.ticketId, 32), page.marginX + 304, y + 77);
  }
  y += result.scope === "ticket" ? 132 : 102;
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...colors.subtle);
  doc.text(`Gerado em ${formatReportDateTime(generatedAt)} · Responsável: ${generatedBy}`, page.marginX, y); y += 22;
  const exportedEvents = result.canViewTechnicalAudit ? [...result.events, ...result.technicalEvents] : result.events;
  for (const item of exportedEvents) {
    const description = doc.splitTextToSize(item.description ?? "", 355) as string[];
    const reason = item.reason ? doc.splitTextToSize(item.reason, 320) as string[] : [];
    const detail = item.detail ? doc.splitTextToSize(item.detail, 320) as string[] : [];
    const height = 62 + (description.length * 11) + (reason.length * 11) + (detail.length * 11) + (item.hasTransition ? 22 : 0);
    if (y + height > page.height - page.bottom - 12) addPage();
    doc.setFillColor(...colors.white); doc.setDrawColor(...colors.border); doc.roundedRect(page.marginX, y, contentWidth, height, 5, 5, "FD");
    doc.setFillColor(...colors.card); doc.roundedRect(page.marginX + 1, y + 1, 110, height - 2, 4, 4, "F");
    doc.setTextColor(...colors.muted); doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.text("DATA/HORA", page.marginX + 10, y + 17);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.text(doc.splitTextToSize(formatReportDateTime(item.occurredAt), 91), page.marginX + 10, y + 33);
    const x = page.marginX + 124; let lineY = y + 18;
    doc.setTextColor(...colors.text); doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text(item.label, x, lineY); lineY += 15;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(...colors.muted); if (description.length) { doc.text(description, x, lineY); lineY += description.length * 11; }
    if (item.hasTransition) {
      lineY += 3; doc.setTextColor(...colors.text); doc.setFont("helvetica", "bold"); doc.text(String(item.previousState), x, lineY);
      const previousWidth = doc.getTextWidth(String(item.previousState)); const arrowX = x + previousWidth + 9;
      doc.setDrawColor(...colors.green); doc.line(arrowX, lineY - 2, arrowX + 20, lineY - 2); doc.line(arrowX + 20, lineY - 2, arrowX + 15, lineY - 6); doc.line(arrowX + 20, lineY - 2, arrowX + 15, lineY + 2);
      doc.text(String(item.newState), arrowX + 28, lineY); lineY += 16;
    }
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...colors.muted); doc.text("Operador:", x, lineY); doc.setTextColor(...colors.text); doc.text(item.operator, x + 47, lineY); lineY += 12;
    if (reason.length) { doc.setTextColor(...colors.muted); doc.text("Motivo:", x, lineY); doc.setTextColor(...colors.text); doc.text(reason, x + 47, lineY); lineY += reason.length * 11; }
    if (detail.length) { doc.setTextColor(...colors.muted); doc.text("Alteração:", x, lineY); doc.setTextColor(...colors.text); doc.text(detail, x + 47, lineY); }
    y += height + 9;
  }
  finalizeReportPages(doc, generatedAt, "Militrin · Histórico administrativo");
  return Buffer.from(doc.output("arraybuffer"));
}
