import type { ReportResultError, ReportResultSuccess, ReportSupabaseClient } from "./types";

export function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

export function pct(part: number, total: number) {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

export function countBy<T>(rows: T[], keyOf: (row: T) => string) {
  const map = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

export function reportError(message: string | null | undefined): ReportResultError {
  return { success: false, message: message ?? "Não foi possível gerar o relatório." };
}

export function reportSuccess(input: Omit<ReportResultSuccess, "success">): ReportResultSuccess {
  const maximumRows = 2000;
  if (input.rows.length <= maximumRows) return { success: true, ...input };
  const notice = `Resultado limitado aos ${maximumRows} registros mais recentes. Refine os filtros para obter o conjunto completo.`;
  return {
    success: true,
    ...input,
    subtitle: `${input.subtitle} · ${notice}`,
    rows: input.rows.slice(0, maximumRows),
    notice,
  };
}

export async function resolveRequiredEvent(supabase: ReportSupabaseClient, eventId: string | null, organizationId: string) {
  if (!eventId) return { error: "Selecione um evento." } as const;
  const { data, error } = await supabase.from("events").select("id,name").eq("id", eventId).eq("organization_id", organizationId).maybeSingle();
  if (error) return { error: error.message ?? "Erro ao buscar evento." } as const;
  if (!data) return { error: "Evento não encontrado nesta organização." } as const;
  return { event: data as { id: string; name: string } } as const;
}

export async function resolveOptionalEvent(supabase: ReportSupabaseClient, eventId: string | null, organizationId: string) {
  if (!eventId) return { event: null } as const;
  const resolved = await resolveRequiredEvent(supabase, eventId, organizationId);
  if ("error" in resolved) return resolved;
  return { event: resolved.event } as const;
}

export function dateRangeLabel(dateFrom: string | null, dateTo: string | null) {
  if (!dateFrom && !dateTo) return "";
  return ` · Período: ${dateFrom ?? "início"} a ${dateTo ?? "hoje"}`;
}
