import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { dateRangeLabel, money, reportError, reportSuccess, resolveOptionalEvent } from "../helpers";
import { formatDateBR } from "@/lib/utils/date";

const ENTRY_KIND_LABELS: Record<string, string> = {
  revenue: "Receita",
  expense: "Despesa",
  transfer: "Transferência",
  adjustment: "Ajuste",
  reversal: "Estorno",
};
const LIFECYCLE_LABELS: Record<string, string> = {
  draft: "Rascunho",
  open: "Em aberto",
  partially_settled: "Parcialmente liquidado",
  settled: "Liquidado",
  cancelled: "Cancelado",
  partially_reversed: "Parcialmente estornado",
  reversed: "Estornado",
};

async function allocationsForEvent(supabase: ReportSupabaseClient, eventId: string) {
  return supabase.from("financial_event_allocations").select("entry_id,amount").eq("event_id", eventId);
}

export async function financeiroDre(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveOptionalEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let entryIds: string[] | null = null;
  let allocatedAmounts: Map<string, number> | null = null;
  if (resolved.event) {
    const { data: allocations, error: allocationError } = await allocationsForEvent(supabase, resolved.event.id);
    if (allocationError) return reportError(allocationError.message);
    entryIds = (allocations ?? []).map((row) => String(row.entry_id));
    allocatedAmounts = new Map((allocations ?? []).map((row) => [String(row.entry_id), Number(row.amount ?? 0)]));
    if (entryIds.length === 0) {
      return reportSuccess({
        reportId: "financeiro-dre",
        title: "DRE simplificado por evento",
        subtitle: `Evento: ${resolved.event.name} · Nenhum lançamento alocado`,
        generatedAt: new Date().toISOString(),
        summaryCards: [{ label: "Receita total", value: money(0) }, { label: "Despesa total", value: money(0) }, { label: "Saldo", value: money(0) }],
        columns: [{ key: "categoria", label: "Categoria" }, { key: "tipo", label: "Tipo" }, { key: "valor", label: "Valor", align: "right" }],
        rows: [],
      });
    }
  }

  let query = supabase.from("financial_entries").select("id,entry_kind,amount,category_id,occurred_on,lifecycle_status").eq("organization_id", ctx.organizationId).neq("lifecycle_status", "cancelled");
  if (entryIds) query = query.in("id", entryIds);
  if (ctx.dateFrom) query = query.gte("occurred_on", ctx.dateFrom);
  if (ctx.dateTo) query = query.lte("occurred_on", ctx.dateTo);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const { data: categories } = await supabase.from("financial_categories").select("id,name").eq("organization_id", ctx.organizationId);
  const categoryNames = new Map((categories ?? []).map((category) => [String(category.id), String(category.name)]));

  const entries = data ?? [];
  let revenue = 0;
  let expense = 0;
  const byGroup = new Map<string, { categoria: string; tipo: string; valor: number }>();
  for (const entry of entries) {
    const kind = String(entry.entry_kind ?? "");
    const amount = allocatedAmounts?.get(String(entry.id)) ?? Number(entry.amount ?? 0);
    if (kind === "revenue") revenue += amount;
    if (kind === "expense") expense += amount;
    const categoria = entry.category_id ? categoryNames.get(String(entry.category_id)) ?? "Sem categoria" : "Sem categoria";
    const key = `${categoria}::${kind}`;
    const existing = byGroup.get(key);
    if (existing) existing.valor += amount;
    else byGroup.set(key, { categoria, tipo: ENTRY_KIND_LABELS[kind] ?? kind, valor: amount });
  }

  return reportSuccess({
    reportId: "financeiro-dre",
    title: "DRE simplificado por evento",
    subtitle: `${resolved.event ? `Evento: ${resolved.event.name}` : "Todos os eventos"}${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Receita total", value: money(revenue) },
      { label: "Despesa total", value: money(expense) },
      { label: "Saldo", value: money(revenue - expense) },
    ],
    columns: [
      { key: "categoria", label: "Categoria" },
      { key: "tipo", label: "Tipo" },
      { key: "valor", label: "Valor", align: "right" },
    ],
    rows: Array.from(byGroup.values())
      .sort((a, b) => b.valor - a.valor)
      .map((row) => ({ categoria: row.categoria, tipo: row.tipo, valor: money(row.valor) })),
  });
}

export async function financeiroLancamentos(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveOptionalEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let entryIds: string[] | null = null;
  if (resolved.event) {
    const { data: allocations, error: allocationError } = await allocationsForEvent(supabase, resolved.event.id);
    if (allocationError) return reportError(allocationError.message);
    entryIds = (allocations ?? []).map((row) => String(row.entry_id));
  }

  let query = supabase
    .from("financial_entries")
    .select("description,entry_kind,lifecycle_status,amount,occurred_on,due_date,financial_categories(name),financial_suppliers(display_name,legal_name)")
    .eq("organization_id", ctx.organizationId)
    .order("occurred_on", { ascending: false })
    .limit(2001);
  if (entryIds) query = query.in("id", entryIds.length ? entryIds : ["00000000-0000-0000-0000-000000000000"]);
  if (ctx.dateFrom) query = query.gte("occurred_on", ctx.dateFrom);
  if (ctx.dateTo) query = query.lte("occurred_on", ctx.dateTo);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const rows = (data ?? []).map((entry) => {
    const category = Array.isArray(entry.financial_categories) ? entry.financial_categories[0] : entry.financial_categories;
    const supplier = Array.isArray(entry.financial_suppliers) ? entry.financial_suppliers[0] : entry.financial_suppliers;
    return {
      descricao: String(entry.description ?? ""),
      tipo: ENTRY_KIND_LABELS[String(entry.entry_kind ?? "")] ?? String(entry.entry_kind ?? ""),
      status: LIFECYCLE_LABELS[String(entry.lifecycle_status ?? "")] ?? String(entry.lifecycle_status ?? ""),
      categoria: category?.name ? String(category.name) : "-",
      fornecedor: supplier?.display_name ? String(supplier.display_name) : supplier?.legal_name ? String(supplier.legal_name) : "-",
      valor: money(Number(entry.amount ?? 0)),
      ocorrido_em: entry.occurred_on ? formatDateBR(String(entry.occurred_on)) : "-",
    };
  });

  return reportSuccess({
    reportId: "financeiro-lancamentos",
    title: "Lançamentos do razão",
    subtitle: `${resolved.event ? `Evento: ${resolved.event.name}` : "Todos os eventos"} · ${rows.length} lançamento(s)${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [{ label: "Lançamentos listados", value: String(rows.length) }],
    columns: [
      { key: "descricao", label: "Descrição" },
      { key: "tipo", label: "Tipo" },
      { key: "status", label: "Status" },
      { key: "categoria", label: "Categoria" },
      { key: "fornecedor", label: "Fornecedor" },
      { key: "valor", label: "Valor", align: "right" },
      { key: "ocorrido_em", label: "Ocorrido em" },
    ],
    rows,
  });
}
