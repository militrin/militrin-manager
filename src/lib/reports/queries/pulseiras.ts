import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { dateRangeLabel, pct, reportError, reportSuccess, resolveRequiredEvent } from "../helpers";
import { formatDateTimeBR } from "@/lib/utils/date";

const WRISTBAND_ACTIONS = ["wristband_linked", "wristband_unlinked", "wristband_blocked"];
const STATUS_LABELS: Record<string, string> = {
  active: "Ativa",
  blocked: "Bloqueada",
  lost: "Perdida",
  replaced: "Substituída",
  unlinked: "Desvinculada",
};

async function loadWristbandOperators(supabase: ReportSupabaseClient, eventId: string) {
  // Fix: audit_logs nao tem coluna "actor" (ver 20260815006100_fix_active_db_lint_contracts.sql)
  // -- o ator de toda RPC deste modulo vai em details->>'actor_email', nunca
  // numa coluna top-level. Selecionar "actor" direto sempre falhava/voltava
  // vazio; corrigido pra ler do jsonb correto.
  const { data } = await supabase.from("audit_logs").select("entity_id,details,created_at").eq("event_id", eventId).in("action", WRISTBAND_ACTIONS);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    const entityId = String(row.entity_id ?? "");
    if (!entityId) continue;
    const details = row.details && typeof row.details === "object" && !Array.isArray(row.details) ? row.details as Record<string, unknown> : null;
    const actor = details?.actor_email ?? details?.actor_user_id ?? null;
    map.set(entityId, actor ? String(actor) : "Não informado");
  }
  return map;
}

export async function pulseirasResumo(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  const { data, error } = await supabase.from("participant_wristbands").select("status").eq("event_id", resolved.event.id);
  if (error) return reportError(error.message);

  const rows = data ?? [];
  const total = rows.length;
  const byStatus = new Map<string, number>();
  for (const row of rows) {
    const status = String(row.status ?? "");
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }
  const active = byStatus.get("active") ?? 0;
  const problem = (byStatus.get("blocked") ?? 0) + (byStatus.get("lost") ?? 0);

  return reportSuccess({
    reportId: "pulseiras-resumo",
    title: "Pulseiras vinculadas vs. bloqueadas/perdidas",
    subtitle: `Evento: ${resolved.event.name}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Total de pulseiras", value: String(total) },
      { label: "Ativas", value: `${active} (${pct(active, total)})` },
      { label: "Bloqueadas ou perdidas", value: `${problem} (${pct(problem, total)})` },
    ],
    columns: [
      { key: "status", label: "Status" },
      { key: "quantidade", label: "Quantidade", align: "right" },
      { key: "percentual", label: "% do total", align: "right" },
    ],
    rows: Array.from(byStatus, ([status, count]) => ({
      status: STATUS_LABELS[status] ?? status,
      quantidade: count,
      percentual: pct(count, total),
    })).sort((a, b) => Number(b.quantidade) - Number(a.quantidade)),
  });
}

export async function pulseirasHistorico(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase
    .from("participant_wristbands")
    .select("id,code,status,linked_at,unlinked_at,participants(full_name)")
    .eq("event_id", resolved.event.id)
    .order("linked_at", { ascending: false })
    .limit(2001);
  if (ctx.dateFrom) query = query.gte("linked_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("linked_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const operatorByWristband = await loadWristbandOperators(supabase, resolved.event.id);
  const rows = (data ?? []).map((wristband) => {
    const participant = Array.isArray(wristband.participants) ? wristband.participants[0] : wristband.participants;
    return {
      codigo: String(wristband.code ?? ""),
      participante: participant?.full_name ? String(participant.full_name) : "-",
      status: STATUS_LABELS[String(wristband.status ?? "")] ?? String(wristband.status ?? ""),
      vinculada_em: wristband.linked_at ? formatDateTimeBR(String(wristband.linked_at)) : "-",
      desvinculada_em: wristband.unlinked_at ? formatDateTimeBR(String(wristband.unlinked_at)) : "-",
      operador: operatorByWristband.get(String(wristband.id)) ?? "Não identificado",
    };
  });

  return reportSuccess({
    reportId: "pulseiras-historico",
    title: "Histórico de pulseiras",
    subtitle: `Evento: ${resolved.event.name} · ${rows.length} registro(s)${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [{ label: "Registros listados", value: String(rows.length) }],
    columns: [
      { key: "codigo", label: "Código" },
      { key: "participante", label: "Participante" },
      { key: "status", label: "Status" },
      { key: "vinculada_em", label: "Vinculada em" },
      { key: "desvinculada_em", label: "Desvinculada em" },
      { key: "operador", label: "Operador" },
    ],
    rows,
  });
}
