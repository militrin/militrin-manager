import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { dateRangeLabel, reportError, reportSuccess, resolveOptionalEvent } from "../helpers";
import { formatDateBR, formatDateTimeBR } from "@/lib/utils/date";

export async function equipeRanking(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveOptionalEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase.from("audit_logs").select("actor,action,created_at").order("created_at", { ascending: false }).limit(2001);
  if (resolved.event) query = query.eq("event_id", resolved.event.id);
  if (ctx.dateFrom) query = query.gte("created_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("created_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const logs = data ?? [];
  const byOperator = new Map<string, number>();
  const byAction = new Map<string, number>();
  const groups = new Map<string, { day: string; operador: string; acoes: number }>();
  for (const log of logs) {
    const operator = String(log.actor ?? "system");
    const action = String(log.action ?? "");
    byOperator.set(operator, (byOperator.get(operator) ?? 0) + 1);
    byAction.set(action, (byAction.get(action) ?? 0) + 1);
    const day = formatDateBR(String(log.created_at ?? ""));
    const key = `${day}::${operator}`;
    const existing = groups.get(key);
    if (existing) existing.acoes += 1;
    else groups.set(key, { day, operador: operator, acoes: 1 });
  }
  const topAction = Array.from(byAction.entries()).sort((a, b) => b[1] - a[1])[0];

  return reportSuccess({
    reportId: "equipe-ranking",
    title: "Ranking de ações por operador",
    subtitle: `${resolved.event ? `Evento: ${resolved.event.name}` : "Todos os eventos"}${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Total de ações", value: String(logs.length) },
      { label: "Operadores distintos", value: String(byOperator.size) },
      { label: "Ação mais frequente", value: topAction ? `${topAction[0]} (${topAction[1]})` : "-" },
    ],
    columns: [
      { key: "day", label: "Data" },
      { key: "operador", label: "Operador" },
      { key: "acoes", label: "Ações", align: "right" },
    ],
    rows: Array.from(groups.values()).sort((a, b) => b.acoes - a.acoes),
  });
}

export async function equipeAuditoria(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveOptionalEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase.from("audit_logs").select("actor,action,entity_type,entity_id,created_at").order("created_at", { ascending: false }).limit(2001);
  if (resolved.event) query = query.eq("event_id", resolved.event.id);
  if (ctx.dateFrom) query = query.gte("created_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("created_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const rows = (data ?? []).map((log) => ({
    data: formatDateTimeBR(String(log.created_at ?? "")),
    operador: String(log.actor ?? "system"),
    acao: String(log.action ?? ""),
    entidade: String(log.entity_type ?? ""),
    entidade_id: log.entity_id ? String(log.entity_id) : "-",
  }));

  return reportSuccess({
    reportId: "equipe-auditoria",
    title: "Trilha de auditoria",
    subtitle: `${resolved.event ? `Evento: ${resolved.event.name}` : "Todos os eventos"} · ${rows.length} registro(s)${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [{ label: "Registros listados", value: String(rows.length) }],
    columns: [
      { key: "data", label: "Data" },
      { key: "operador", label: "Operador" },
      { key: "acao", label: "Ação" },
      { key: "entidade", label: "Entidade" },
      { key: "entidade_id", label: "ID da entidade" },
    ],
    rows,
  });
}
