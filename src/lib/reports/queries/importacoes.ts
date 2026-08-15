import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { pct, reportError, reportSuccess, resolveOptionalEvent } from "../helpers";
import { formatDateTimeBR } from "@/lib/utils/date";

const IMPORT_TYPE_LABELS: Record<string, string> = {
  historical_participations: "Participações históricas",
  current_event_registrations: "Inscrições do evento atual",
  inventory: "Estoque",
  payments: "Pagamentos",
};

export async function importacoesTaxaErro(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveOptionalEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase
    .from("import_batches")
    .select("file_name,import_type,total_rows,imported_rows,skipped_rows,error_rows,created_at")
    .order("created_at", { ascending: false })
    .limit(2001);
  if (resolved.event) query = query.eq("event_id", resolved.event.id);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const batches = data ?? [];
  const totalRows = batches.reduce((sum, batch) => sum + Number(batch.total_rows ?? 0), 0);
  const totalErrors = batches.reduce((sum, batch) => sum + Number(batch.error_rows ?? 0), 0);

  return reportSuccess({
    reportId: "importacoes-taxa-erro",
    title: "Taxa de erro/pendência por lote importado",
    subtitle: resolved.event ? `Evento: ${resolved.event.name}` : "Todos os eventos",
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Lotes importados", value: String(batches.length) },
      { label: "Linhas processadas", value: String(totalRows) },
      { label: "Taxa de erro geral", value: pct(totalErrors, totalRows) },
    ],
    columns: [
      { key: "arquivo", label: "Arquivo" },
      { key: "tipo", label: "Tipo" },
      { key: "total", label: "Total", align: "right" },
      { key: "importadas", label: "Importadas", align: "right" },
      { key: "ignoradas", label: "Ignoradas", align: "right" },
      { key: "erros", label: "Erros", align: "right" },
      { key: "taxa_erro", label: "Taxa de erro", align: "right" },
      { key: "criado_em", label: "Criado em" },
    ],
    rows: batches.map((batch) => ({
      arquivo: batch.file_name ? String(batch.file_name) : "-",
      tipo: IMPORT_TYPE_LABELS[String(batch.import_type ?? "")] ?? String(batch.import_type ?? ""),
      total: Number(batch.total_rows ?? 0),
      importadas: Number(batch.imported_rows ?? 0),
      ignoradas: Number(batch.skipped_rows ?? 0),
      erros: Number(batch.error_rows ?? 0),
      taxa_erro: pct(Number(batch.error_rows ?? 0), Number(batch.total_rows ?? 0)),
      criado_em: formatDateTimeBR(String(batch.created_at ?? "")),
    })),
  });
}

export async function importacoesPendencias(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveOptionalEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase
    .from("participant_data_issues")
    .select("field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery,created_at,participants!inner(full_name,event_id)")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(2001);
  if (resolved.event) query = query.eq("participants.event_id", resolved.event.id);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const rows = (data ?? []).map((issue) => {
    const participant = Array.isArray(issue.participants) ? issue.participants[0] : issue.participants;
    const blocks = [
      issue.blocks_payment ? "pagamento" : null,
      issue.blocks_ticket_issuance ? "emissão de ingresso" : null,
      issue.blocks_checkin ? "check-in" : null,
      issue.blocks_kit_delivery ? "entrega de kit" : null,
    ].filter((label): label is string => Boolean(label));
    return {
      participante: participant?.full_name ? String(participant.full_name) : "-",
      campo: String(issue.field_code ?? ""),
      motivo: String(issue.message ?? issue.issue_type ?? ""),
      bloqueia: blocks.length ? blocks.join(", ") : "Não bloqueia",
      criado_em: formatDateTimeBR(String(issue.created_at ?? "")),
    };
  });

  return reportSuccess({
    reportId: "importacoes-pendencias",
    title: "Pendências cadastrais em aberto",
    subtitle: `${resolved.event ? `Evento: ${resolved.event.name}` : "Todos os eventos"} · ${rows.length} pendência(s)`,
    generatedAt: new Date().toISOString(),
    summaryCards: [{ label: "Pendências em aberto", value: String(rows.length) }],
    columns: [
      { key: "participante", label: "Participante" },
      { key: "campo", label: "Campo" },
      { key: "motivo", label: "Motivo" },
      { key: "bloqueia", label: "Bloqueia" },
      { key: "criado_em", label: "Aberta em" },
    ],
    rows,
  });
}
