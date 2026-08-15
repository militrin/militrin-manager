import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { countBy, dateRangeLabel, reportError, reportSuccess, resolveRequiredEvent } from "../helpers";
import { formatDateBR, formatDateTimeBR } from "@/lib/utils/date";

const DELIVERY_ACTIONS = ["participant_kit_item_delivered", "ticket_kit_item_delivered", "combined_kit_delivery_and_checkin", "kit_delivered"];

async function loadDeliveryOperators(supabase: ReportSupabaseClient, eventId: string) {
  const { data } = await supabase
    .from("audit_logs")
    .select("entity_id,actor,created_at,details")
    .eq("event_id", eventId)
    .in("action", DELIVERY_ACTIONS);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const entityId = String(row.entity_id ?? "");
    if (!entityId || map.has(entityId)) continue;
    map.set(entityId, String(row.actor ?? "Não informado"));
  }
  return map;
}

export async function kitsPorOperador(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase
    .from("participant_kit_items")
    .select("id,delivered_at,status")
    .eq("event_id", resolved.event.id)
    .eq("status", "delivered")
    .not("delivered_at", "is", null);
  if (ctx.dateFrom) query = query.gte("delivered_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("delivered_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const operatorByItem = await loadDeliveryOperators(supabase, resolved.event.id);
  const items = data ?? [];
  const groups = new Map<string, { day: string; operator: string; count: number }>();
  for (const item of items) {
    const day = formatDateBR(String(item.delivered_at ?? ""));
    const operator = operatorByItem.get(String(item.id)) ?? "Não identificado";
    const key = `${day}::${operator}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { day, operator, count: 1 });
  }

  const byOperatorTotals = countBy(items, (item) => operatorByItem.get(String(item.id)) ?? "Não identificado");
  const topOperator = Array.from(byOperatorTotals.entries()).sort((a, b) => b[1] - a[1])[0];

  return reportSuccess({
    reportId: "kits-por-operador",
    title: "Kits entregues por dia e por operador",
    subtitle: `Evento: ${resolved.event.name}${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Total entregue", value: String(items.length) },
      { label: "Operadores distintos", value: String(byOperatorTotals.size) },
      { label: "Operador com mais entregas", value: topOperator ? `${topOperator[0]} (${topOperator[1]})` : "-" },
    ],
    columns: [
      { key: "day", label: "Data" },
      { key: "operator", label: "Operador" },
      { key: "count", label: "Itens entregues", align: "right" },
    ],
    rows: Array.from(groups.values()).sort((a, b) => a.day.localeCompare(b.day)),
  });
}

export async function kitsEntregasDetalhado(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase
    .from("participant_kit_items")
    .select("id,status,delivered_at,participants(full_name),event_kit_items(name)")
    .eq("event_id", resolved.event.id)
    .order("delivered_at", { ascending: false })
    .limit(2001);
  if (ctx.dateFrom) query = query.gte("delivered_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("delivered_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const operatorByItem = await loadDeliveryOperators(supabase, resolved.event.id);
  const rows = (data ?? []).map((item) => {
    const participant = Array.isArray(item.participants) ? item.participants[0] : item.participants;
    const kitItem = Array.isArray(item.event_kit_items) ? item.event_kit_items[0] : item.event_kit_items;
    return {
      item: kitItem?.name ? String(kitItem.name) : "Item",
      participante: participant?.full_name ? String(participant.full_name) : "-",
      status: item.status === "delivered" ? "Entregue" : item.status === "cancelled" ? "Cancelado" : "Pendente",
      operador: item.status === "delivered" ? (operatorByItem.get(String(item.id)) ?? "Não identificado") : "-",
      entregue_em: item.delivered_at ? formatDateTimeBR(String(item.delivered_at)) : "-",
    };
  });

  return reportSuccess({
    reportId: "kits-entregas-detalhado",
    title: "Entregas de kit, item a item",
    subtitle: `Evento: ${resolved.event.name} · ${rows.length} registro(s)${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [{ label: "Registros listados", value: String(rows.length) }],
    columns: [
      { key: "item", label: "Item" },
      { key: "participante", label: "Participante" },
      { key: "status", label: "Status" },
      { key: "operador", label: "Operador" },
      { key: "entregue_em", label: "Entregue em" },
    ],
    rows,
  });
}
