import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { dateRangeLabel, reportError, reportSuccess, resolveRequiredEvent } from "../helpers";
import { formatDateBR } from "@/lib/utils/date";
import { ticketDisplayReference } from "@/lib/display-reference";
import { resolveOperatorNames } from "@/lib/admin/operator-names";
import { sensitiveActionReasonLabel } from "@/lib/admin/sensitive-action-reasons";
import { REASON_CODE_LABELS } from "@/app/operacoes/types";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";

type Row = Record<string, unknown>;
const one = (value: unknown): Row | null => (Array.isArray(value) ? (value[0] as Row | undefined) ?? null : (value as Row | null));

function formatTimeBR(value: unknown) {
  const date = value ? new Date(String(value)) : null;
  if (!date || Number.isNaN(date.getTime())) return "-";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function maskEmail(value: unknown) {
  const email = String(value ?? "");
  const at = email.indexOf("@");
  return at > 0 ? `${email.slice(0, 2)}***@${email.slice(at + 1)}` : null;
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = value == null ? "" : String(value).trim();
    if (text) return text;
  }
  return "";
}

// ── Histórico de Operações ──────────────────────────────────────────────────
// Log imutável: cada linha é uma ação já ocorrida (audit_logs + ticket_holder_history),
// nunca o estado atual. Uma reversão gera uma linha NOVA; a linha original
// nunca é reescrita ou removida daqui.

type ActionMeta = { label: string; bucket: "kit_delivered" | "kit_undone" | "checkin" | "checkin_undone" | "additional_item" | "correction" | "issuance" };

const ACTION_ALLOWLIST: Record<string, ActionMeta> = {
  ticket_kit_item_delivered: { label: "Item de kit entregue", bucket: "kit_delivered" },
  ticket_kit_item_delivery_undone: { label: "Entrega de kit desfeita", bucket: "kit_undone" },
  combined_kit_delivery_and_checkin: { label: "Kit entregue + check-in", bucket: "kit_delivered" },
  ticket_checkin_entry: { label: "Check-in realizado", bucket: "checkin" },
  ticket_checkin_undo: { label: "Check-in desfeito", bucket: "checkin_undone" },
  ticket_shirt_admin_changed: { label: "Camiseta corrigida (admin)", bucket: "correction" },
  ticket_shirt_admin_corrected_after_operation: { label: "Camiseta corrigida (pós-operação)", bucket: "correction" },
  wristband_linked: { label: "Pulseira vinculada", bucket: "correction" },
  wristband_unlinked: { label: "Pulseira desvinculada", bucket: "correction" },
  wristband_blocked: { label: "Pulseira bloqueada", bucket: "correction" },
  store_order_item_delivered: { label: "Item adicional entregue", bucket: "additional_item" },
  store_order_item_delivery_undone: { label: "Entrega de item adicional desfeita", bucket: "additional_item" },
  store_item_admin_granted: { label: "Item adicional concedido (admin)", bucket: "additional_item" },
  manual_ticket_issued: { label: "Ingresso emitido manualmente", bucket: "issuance" },
};

const HOLDER_HISTORY_ALLOWLIST: Record<string, ActionMeta> = {
  holder_assigned: { label: "Titular definido", bucket: "correction" },
  holder_changed: { label: "Titular alterado", bucket: "correction" },
  holder_removed: { label: "Titular removido", bucket: "correction" },
};

type NormalizedEvent = {
  id: string;
  occurredAt: string;
  action: string;
  meta: ActionMeta;
  ticketId: string | null;
  participantId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  actorOrigin: string | null;
  reason: string | null;
  shirtFromDetails: string | null;
  resultLabel: string;
};

// Duas vocabulares de reason_code coexistem no sistema: desfazer check-in/kit
// usa REASON_CODE_LABELS (operacoes/types.ts -- operational_error,
// wrong_person, accidental_scan...), troca/remocao de titular usa
// sensitive-action-reasons.ts (registration_correction, buyer_request...).
// Tenta as duas antes de cair no codigo cru, pra nunca engolir um motivo
// valido so porque veio da vocabulario "errado" pro helper "errado".
function reasonLabel(details: Row) {
  if (details.reason) return String(details.reason);
  if (details.reason_text) return String(details.reason_text);
  const code = details.reason_code ? String(details.reason_code) : null;
  if (!code) return null;
  return (REASON_CODE_LABELS as Record<string, string>)[code] ?? sensitiveActionReasonLabel(code) ?? code;
}

function operatorLabel(actorUserId: string | null, actorEmail: string | null, actorOrigin: string | null, names: Map<string, string>) {
  // Nome resolvido (customer_profiles/Admin Auth API) vem ANTES do e-mail
  // mascarado: varias actions (wristband_unlinked, store_item_admin_granted,
  // ticket_checkin_undo...) gravam actor_email JUNTO com actor_user_id --
  // mostrar "h.***@gmail.com" quando já sabemos que é "Douglas Hobold" é
  // pior que o necessário, e contraria o pedido explícito de resolver o
  // nome real em vez de um substituto.
  if (actorUserId) {
    const resolvedName = names.get(actorUserId);
    if (resolvedName) return resolvedName;
  }
  const masked = maskEmail(actorEmail);
  if (masked) return masked;
  if (actorOrigin === "portal") return "Titular autenticado";
  if (actorUserId) return "Operador administrativo";
  return "Sistema";
}

export async function operacoesHistorico(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);
  const eventId = resolved.event.id;

  // audit_logs tem RLS habilitado SEM NENHUMA policy de SELECT (confirmado:
  // 10 linhas reais via service_role, 0 via client do usuario, mesmo filtro
  // exato, evento Militrin) -- por isso o relatorio sempre voltava "0 ações"
  // mesmo com historico real. run-report.ts já validou operations.view_report
  // ANTES de chamar esta função (ver src/lib/reports/run-report.ts); o
  // evento também já foi confirmado como pertencente à organização do
  // chamador por resolveRequiredEvent logo acima, com o client normal (esse
  // sim tem RLS correta em `events`). Só a leitura de audit_logs em si
  // precisa do client de service role -- todo o resto da função (tickets,
  // order_items, orders, participants, get_operation_buyers) continua no
  // client do usuário, sem elevação de privilégio desnecessária. A migration
  // 20260886000000 (local, não aplicada) fecha isso na origem com uma
  // policy; até lá, este é o contorno seguro.
  const auditLogsClient = createServiceRoleSupabaseClient();
  let auditQuery = auditLogsClient
    .from("audit_logs")
    .select("id,action,entity_type,entity_id,details,created_at")
    .eq("event_id", eventId)
    .in("action", Object.keys(ACTION_ALLOWLIST))
    .order("created_at", { ascending: false })
    .limit(2001);
  // "De"/"Até" são datas de calendário digitadas pelo operador pensando no
  // horário do evento (Militrin só opera no Brasil) -- sem offset explícito,
  // "T00:00:00" seria lido como meia-noite UTC (3h adiantado), incluindo/
  // excluindo até 3h de ações do fuso errado perto da virada do dia. Brasil
  // não tem mais horário de verão desde 2019, então -03:00 é estável.
  if (ctx.dateFrom) auditQuery = auditQuery.gte("created_at", `${ctx.dateFrom}T00:00:00-03:00`);
  if (ctx.dateTo) auditQuery = auditQuery.lte("created_at", `${ctx.dateTo}T23:59:59-03:00`);
  const { data: auditRows, error: auditError } = await auditQuery;
  if (auditError) return reportError(auditError.message);

  let holderQuery = supabase
    .from("ticket_holder_history")
    .select("id,ticket_id,operation,actor_user_id,actor_origin,reason_text,reason,created_at")
    .eq("event_id", eventId)
    .in("operation", Object.keys(HOLDER_HISTORY_ALLOWLIST))
    .order("created_at", { ascending: false })
    .limit(2001);
  if (ctx.dateFrom) holderQuery = holderQuery.gte("created_at", `${ctx.dateFrom}T00:00:00-03:00`);
  if (ctx.dateTo) holderQuery = holderQuery.lte("created_at", `${ctx.dateTo}T23:59:59-03:00`);
  const { data: holderRows, error: holderError } = await holderQuery;
  if (holderError) return reportError(holderError.message);

  const normalized: NormalizedEvent[] = [];

  for (const row of auditRows ?? []) {
    const action = String(row.action ?? "");
    const meta = ACTION_ALLOWLIST[action];
    if (!meta) continue;
    const details = one(row.details) ?? {};
    // Nem toda action carrega ticket_id (ex.: store_item_admin_granted so
    // grava participant_id/registration_contact_id) -- guarda participantId
    // separado pra resolver titular/comprador mesmo sem ticket.
    const ticketId = String(details.ticket_id ?? (row.entity_type === "tickets" ? row.entity_id : "") ?? "") || null;
    const participantId = String(details.participant_id ?? "") || null;
    const isUndo = meta.bucket === "kit_undone" || meta.bucket === "checkin_undone";
    normalized.push({
      id: `audit-${row.id}`,
      occurredAt: String(row.created_at),
      action,
      meta,
      ticketId,
      participantId,
      actorUserId: details.actor_user_id ? String(details.actor_user_id) : null,
      actorEmail: details.actor_email ? String(details.actor_email) : null,
      actorOrigin: details.actor_origin ? String(details.actor_origin) : null,
      reason: reasonLabel(details),
      shirtFromDetails: null,
      resultLabel: isUndo ? "Desfeita" : "Concluída",
    });
  }

  for (const row of holderRows ?? []) {
    const operation = String(row.operation ?? "");
    const meta = HOLDER_HISTORY_ALLOWLIST[operation];
    if (!meta) continue;
    normalized.push({
      id: `holder-${row.id}`,
      occurredAt: String(row.created_at),
      action: operation,
      meta,
      ticketId: row.ticket_id ? String(row.ticket_id) : null,
      participantId: null,
      actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      actorEmail: null,
      actorOrigin: row.actor_origin ? String(row.actor_origin) : null,
      reason: reasonLabel(row),
      shirtFromDetails: null,
      resultLabel: "Concluída",
    });
  }

  normalized.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  const capped = normalized.slice(0, 2000);

  const ticketIds = [...new Set(capped.map((event) => event.ticketId).filter((value): value is string => Boolean(value)))];
  const ticketMap = new Map<string, Row>();
  const orderItemMap = new Map<string, Row>();
  const orderMap = new Map<string, Row>();
  const participantMap = new Map<string, Row>();

  if (ticketIds.length) {
    const { data: tickets } = await supabase.from("tickets").select("id,order_id,order_item_id,participant_id").in("id", ticketIds);
    for (const ticket of tickets ?? []) ticketMap.set(String(ticket.id), ticket as Row);

    const orderItemIds = [...new Set((tickets ?? []).map((ticket) => ticket.order_item_id).filter(Boolean).map(String))];
    if (orderItemIds.length) {
      const { data: orderItems } = await supabase.from("order_items").select("id,order_id,participant_id,holder_full_name,shirt_type,shirt_size,item_position").in("id", orderItemIds);
      for (const item of orderItems ?? []) orderItemMap.set(String(item.id), item as Row);
    }

    const orderIds = [...new Set([
      ...(tickets ?? []).map((ticket) => ticket.order_id).filter(Boolean).map(String),
      ...[...orderItemMap.values()].map((item) => item.order_id).filter(Boolean).map(String),
    ])];
    if (orderIds.length) {
      const { data: orders } = await supabase.from("orders").select("id,user_id,display_number,order_number").in("id", orderIds);
      for (const order of orders ?? []) orderMap.set(String(order.id), order as Row);
    }
  }

  // Alguns actions (ex.: store_item_admin_granted) so tem participant_id, sem
  // ticket_id -- inclui esses diretamente pra "titular" ainda resolver.
  const participantIds = [...new Set([
    ...[...ticketMap.values()].map((ticket) => ticket.participant_id).filter(Boolean).map(String),
    ...[...orderItemMap.values()].map((item) => item.participant_id).filter(Boolean).map(String),
    ...capped.map((event) => event.participantId).filter((value): value is string => Boolean(value)),
  ])];
  if (participantIds.length) {
    const { data: participants } = await supabase.from("participants").select("id,full_name").in("id", participantIds);
    for (const participant of participants ?? []) participantMap.set(String(participant.id), participant as Row);
  }

  const buyerUserIds = [...new Set([...orderMap.values()].map((order) => order.user_id).filter(Boolean).map(String))];
  const buyerMap = new Map<string, Row>();
  if (buyerUserIds.length) {
    const { data: buyers } = await supabase.rpc("get_operation_buyers", { p_event_id: eventId });
    for (const buyer of (buyers ?? []) as Row[]) buyerMap.set(String(buyer.user_id ?? ""), buyer);
  }

  const actorIds = [...new Set(capped.map((event) => event.actorUserId).filter((value): value is string => Boolean(value)))];
  const operatorNames = await resolveOperatorNames(actorIds);

  const rows = capped.map((event) => {
    const ticket = event.ticketId ? ticketMap.get(event.ticketId) : null;
    const orderItem = ticket?.order_item_id ? orderItemMap.get(String(ticket.order_item_id)) : null;
    const order = (ticket?.order_id ?? orderItem?.order_id) ? orderMap.get(String(ticket?.order_id ?? orderItem?.order_id)) : null;
    const resolvedParticipantId = orderItem?.participant_id ?? ticket?.participant_id ?? event.participantId;
    const participant = resolvedParticipantId ? participantMap.get(String(resolvedParticipantId)) : null;
    const buyer = order?.user_id ? buyerMap.get(String(order.user_id)) : null;

    const referencia = event.ticketId
      ? ticketDisplayReference(order?.display_number, orderItem?.item_position, order?.order_number)
      : "-";
    const camiseta = (event.meta.bucket === "kit_delivered" || event.meta.bucket === "kit_undone" || event.action.includes("shirt")) && orderItem
      ? [orderItem.shirt_type, orderItem.shirt_size].filter(Boolean).join(" ") || "-"
      : "-";

    return {
      data: formatDateBR(event.occurredAt),
      hora: formatTimeBR(event.occurredAt),
      evento: resolved.event.name,
      acao: event.meta.label,
      referencia,
      comprador: buyer?.full_name ? String(buyer.full_name) : order ? "Comprador não identificado" : "-",
      titular: firstNonEmpty(orderItem?.holder_full_name, participant?.full_name) || "Titular não definido",
      camiseta,
      operador: operatorLabel(event.actorUserId, event.actorEmail, event.actorOrigin, operatorNames),
      resultado: event.resultLabel,
      motivo: event.reason ?? "-",
      origem: "Não registrado",
    };
  });

  const countBucket = (bucket: ActionMeta["bucket"]) => capped.filter((event) => event.meta.bucket === bucket).length;

  return reportSuccess({
    reportId: "operacoes-historico",
    title: "Histórico de Operações",
    subtitle: `Evento: ${resolved.event.name} · ${rows.length} ação(ões)${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Kits entregues", value: String(countBucket("kit_delivered")) },
      { label: "Entregas desfeitas", value: String(countBucket("kit_undone")) },
      { label: "Check-ins", value: String(countBucket("checkin")) },
      { label: "Check-ins desfeitos", value: String(countBucket("checkin_undone")) },
      { label: "Itens adicionais entregues", value: String(countBucket("additional_item")) },
      { label: "Correções operacionais", value: String(countBucket("correction")) },
    ],
    columns: [
      { key: "data", label: "Data" },
      { key: "hora", label: "Hora" },
      { key: "acao", label: "Ação" },
      { key: "referencia", label: "Ingresso" },
      { key: "titular", label: "Titular" },
      { key: "comprador", label: "Comprador" },
      { key: "camiseta", label: "Camiseta" },
      { key: "operador", label: "Operador" },
      { key: "resultado", label: "Resultado" },
      { key: "motivo", label: "Motivo" },
      { key: "origem", label: "Origem/Terminal" },
    ],
    rows,
  });
}

// ── Snapshot de Contingência ─────────────────────────────────────────────────
// Estado ATUAL por ingresso -- não é histórico, é uma foto de agora, pensada
// pra baixar antes da entrega de kits/check-in e usar offline se o sistema
// cair. Reaproveita a mesma regra de "ingresso operável" já validada na
// auditoria da Central de Operações (todo ticket do evento entra, mesmo
// cortesia/administrativo/sem comprador/sem titular/categoria nula).

export async function operacoesContingencia(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);
  const eventId = resolved.event.id;

  const { data: eventRow } = await supabase.from("events").select("wristband_enabled").eq("id", eventId).maybeSingle();
  const wristbandEnabled = Boolean(eventRow?.wristband_enabled);

  const { data: tickets, error: ticketsError } = await supabase
    .from("tickets")
    .select("id,status,used_at,order_id,order_item_id,participant_id")
    .eq("event_id", eventId)
    .order("issued_at", { ascending: true })
    .limit(2001);
  if (ticketsError) return reportError(ticketsError.message);

  const ticketIds = (tickets ?? []).map((ticket) => String(ticket.id));
  const orderItemIds = [...new Set((tickets ?? []).map((ticket) => ticket.order_item_id).filter(Boolean).map(String))];
  const orderIds = [...new Set((tickets ?? []).map((ticket) => ticket.order_id).filter(Boolean).map(String))];
  const directParticipantIds = [...new Set((tickets ?? []).map((ticket) => ticket.participant_id).filter(Boolean).map(String))];

  const orderItemMap = new Map<string, Row>();
  if (orderItemIds.length) {
    const { data } = await supabase.from("order_items").select("id,order_id,participant_id,holder_full_name,shirt_type,shirt_size").in("id", orderItemIds);
    for (const item of data ?? []) orderItemMap.set(String(item.id), item as Row);
  }

  const orderItemParticipantIds = [...orderItemMap.values()].map((item) => item.participant_id).filter(Boolean).map(String);
  const participantIds = [...new Set([...directParticipantIds, ...orderItemParticipantIds])];
  const participantMap = new Map<string, Row>();
  if (participantIds.length) {
    const { data } = await supabase.from("participants").select("id,full_name,shirt_type,shirt_size").in("id", participantIds);
    for (const participant of data ?? []) participantMap.set(String(participant.id), participant as Row);
  }

  const orderMap = new Map<string, Row>();
  if (orderIds.length) {
    const { data } = await supabase.from("orders").select("id,user_id,display_number,order_number").in("id", orderIds);
    for (const order of data ?? []) orderMap.set(String(order.id), order as Row);
  }
  const buyerUserIds = [...new Set([...orderMap.values()].map((order) => order.user_id).filter(Boolean).map(String))];
  const buyerMap = new Map<string, Row>();
  if (buyerUserIds.length) {
    const { data: buyers } = await supabase.rpc("get_operation_buyers", { p_event_id: eventId });
    for (const buyer of (buyers ?? []) as Row[]) buyerMap.set(String(buyer.user_id ?? ""), buyer);
  }

  const kitMap = new Map<string, Row[]>();
  const kitItemNames = new Map<string, string>();
  if (ticketIds.length) {
    const { data: kitItems } = await supabase.from("event_kit_items").select("id,name").eq("event_id", eventId).eq("is_active", true);
    for (const item of kitItems ?? []) kitItemNames.set(String(item.id), String(item.name ?? "Item"));
    const { data: links } = await supabase.from("participant_kit_items").select("ticket_id,kit_item_id,status").in("ticket_id", ticketIds);
    for (const link of links ?? []) {
      const key = String(link.ticket_id ?? "");
      if (!key) continue;
      kitMap.set(key, [...(kitMap.get(key) ?? []), link as Row]);
    }
  }

  const wristbandMap = new Map<string, Row>();
  if (ticketIds.length) {
    const { data: wristbands } = await supabase.from("participant_wristbands").select("ticket_id,code,status").in("ticket_id", ticketIds).eq("status", "active");
    for (const wristband of wristbands ?? []) wristbandMap.set(String(wristband.ticket_id ?? ""), wristband as Row);
  }

  const storeItemsByParticipant = new Map<string, string[]>();
  if (participantIds.length) {
    const { data: storeOrders } = await supabase.from("store_orders").select("id,participant_id").eq("event_id", eventId).in("participant_id", participantIds);
    const storeOrderIds = (storeOrders ?? []).map((order) => String(order.id));
    const participantByStoreOrder = new Map((storeOrders ?? []).map((order) => [String(order.id), String(order.participant_id ?? "")]));
    if (storeOrderIds.length) {
      const { data: storeItems } = await supabase.from("store_order_items").select("store_order_id,status,store_items(name)").in("store_order_id", storeOrderIds);
      for (const item of storeItems ?? []) {
        const participantId = participantByStoreOrder.get(String(item.store_order_id ?? ""));
        if (!participantId) continue;
        const itemName = one(item.store_items)?.name ?? "Item";
        const statusLabel = item.status === "delivered" ? "entregue" : item.status === "cancelled" ? "cancelado" : "pendente";
        const list = storeItemsByParticipant.get(participantId) ?? [];
        list.push(`${itemName} (${statusLabel})`);
        storeItemsByParticipant.set(participantId, list);
      }
    }
  }

  const rows = (tickets ?? []).map((ticket) => {
    const ticketId = String(ticket.id);
    const orderItem = ticket.order_item_id ? orderItemMap.get(String(ticket.order_item_id)) : null;
    const order = ticket.order_id ? orderMap.get(String(ticket.order_id)) : null;
    const participantId = String(orderItem?.participant_id ?? ticket.participant_id ?? "");
    const participant = participantId ? participantMap.get(participantId) : null;
    const buyer = order?.user_id ? buyerMap.get(String(order.user_id)) : null;

    const links = kitMap.get(ticketId) ?? [];
    let kitLabel = "Não se aplica";
    if (links.length) {
      const delivered = links.filter((link) => link.status === "delivered").length;
      kitLabel = delivered === 0 ? "Não" : delivered === links.length ? "Sim" : "Parcial";
    }

    const wristband = wristbandMap.get(ticketId);
    const wristbandLabel = !wristbandEnabled ? "Não se aplica" : wristband ? String(wristband.code ?? "Vinculada") : "Sem pulseira";

    const shirtType = orderItem?.shirt_type ?? participant?.shirt_type ?? null;
    const shirtSize = orderItem?.shirt_size ?? participant?.shirt_size ?? null;

    return {
      referencia: order ? ticketDisplayReference(order.display_number, null, order.order_number) : "-",
      titular: firstNonEmpty(orderItem?.holder_full_name, participant?.full_name) || "Titular não definido",
      comprador: buyer?.full_name ? String(buyer.full_name) : order ? "Comprador não identificado" : "-",
      camiseta: [shirtType, shirtSize].filter(Boolean).join(" ") || "Não selecionada",
      kit_entregue: kitLabel,
      checkin: ticket.status === "used" || ticket.used_at ? "Sim" : "Não",
      pulseira: wristbandLabel,
      itens_adicionais: storeItemsByParticipant.get(participantId)?.join(", ") || "-",
    };
  });

  return reportSuccess({
    reportId: "operacoes-contingencia",
    title: "Snapshot de Contingência",
    subtitle: `Evento: ${resolved.event.name} · estado atual em ${new Date().toLocaleString("pt-BR")} · ${rows.length} ingresso(s)`,
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Ingressos", value: String(rows.length) },
      { label: "Kits entregues", value: String(rows.filter((row) => row.kit_entregue === "Sim").length) },
      { label: "Check-ins realizados", value: String(rows.filter((row) => row.checkin === "Sim").length) },
    ],
    columns: [
      { key: "referencia", label: "Ingresso" },
      { key: "titular", label: "Titular" },
      { key: "comprador", label: "Comprador" },
      { key: "camiseta", label: "Camiseta" },
      { key: "kit_entregue", label: "Kit entregue?" },
      { key: "checkin", label: "Check-in?" },
      { key: "pulseira", label: "Pulseira" },
      { key: "itens_adicionais", label: "Itens adicionais" },
    ],
    rows,
    notice: "Este é um retrato do estado ATUAL (não um histórico de ações) — gere de novo pouco antes do uso offline para refletir as últimas operações.",
  });
}
