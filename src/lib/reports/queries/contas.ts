import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { dateRangeLabel, pct, reportError, reportSuccess, resolveOptionalEvent } from "../helpers";
import { formatDateTimeBR } from "@/lib/utils/date";

const STATUS_LABELS: Record<string, string> = { pending: "Pendente", claimed: "Aceito", revoked: "Revogado", expired: "Expirado" };

export async function contasConversao(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveOptionalEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase.from("participant_account_invites").select("status,created_at,claimed_at").eq("organization_id", ctx.organizationId);
  if (resolved.event) query = query.eq("event_id", resolved.event.id);
  if (ctx.dateFrom) query = query.gte("created_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("created_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const invites = data ?? [];
  const total = invites.length;
  const byStatus = new Map<string, number>();
  let claimDurationSumHours = 0;
  let claimedCount = 0;
  for (const invite of invites) {
    const status = String(invite.status ?? "pending");
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    if (invite.claimed_at && invite.created_at) {
      const hours = (new Date(String(invite.claimed_at)).getTime() - new Date(String(invite.created_at)).getTime()) / 3_600_000;
      if (hours >= 0) {
        claimDurationSumHours += hours;
        claimedCount += 1;
      }
    }
  }
  const claimed = byStatus.get("claimed") ?? 0;
  const avgHours = claimedCount ? claimDurationSumHours / claimedCount : 0;

  return reportSuccess({
    reportId: "contas-conversao",
    title: "Conversão de convites de primeiro acesso",
    subtitle: `${resolved.event ? `Evento: ${resolved.event.name}` : "Todos os eventos"}${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Convites enviados", value: String(total) },
      { label: "Taxa de conversão", value: pct(claimed, total) },
      { label: "Tempo médio até aceitar", value: claimedCount ? `${avgHours.toFixed(1)} h` : "-" },
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

export async function contasConvites(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveOptionalEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase
    .from("participant_account_invites")
    .select("email,status,created_at,expires_at,claimed_at,participants(full_name)")
    .eq("organization_id", ctx.organizationId)
    .order("created_at", { ascending: false })
    .limit(2001);
  if (resolved.event) query = query.eq("event_id", resolved.event.id);
  if (ctx.dateFrom) query = query.gte("created_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("created_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const rows = (data ?? []).map((invite) => {
    const participant = Array.isArray(invite.participants) ? invite.participants[0] : invite.participants;
    return {
      participante: participant?.full_name ? String(participant.full_name) : "-",
      email: String(invite.email ?? ""),
      status: STATUS_LABELS[String(invite.status ?? "")] ?? String(invite.status ?? ""),
      criado_em: formatDateTimeBR(String(invite.created_at ?? "")),
      expira_em: invite.expires_at ? formatDateTimeBR(String(invite.expires_at)) : "-",
      aceito_em: invite.claimed_at ? formatDateTimeBR(String(invite.claimed_at)) : "-",
    };
  });

  return reportSuccess({
    reportId: "contas-convites",
    title: "Lista de convites",
    subtitle: `${resolved.event ? `Evento: ${resolved.event.name}` : "Todos os eventos"} · ${rows.length} convite(s)${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [{ label: "Convites listados", value: String(rows.length) }],
    columns: [
      { key: "participante", label: "Participante" },
      { key: "email", label: "E-mail" },
      { key: "status", label: "Status" },
      { key: "criado_em", label: "Criado em" },
      { key: "expira_em", label: "Expira em" },
      { key: "aceito_em", label: "Aceito em" },
    ],
    rows,
  });
}
