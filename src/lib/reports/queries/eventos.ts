import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { pct, reportError, reportSuccess, resolveRequiredEvent } from "../helpers";
import { formatDateTimeBR } from "@/lib/utils/date";

const BATCH_ACTIONS = ["registration_batch_created", "registration_batch_activated", "registration_batch_advanced", "registration_batch_updated"];
const BATCH_ACTION_LABELS: Record<string, string> = {
  registration_batch_created: "Lote criado",
  registration_batch_activated: "Lote ativado",
  registration_batch_advanced: "Avanço automático de lote",
  registration_batch_updated: "Lote atualizado",
};

export async function eventosOcupacao(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  const { data: batches, error: batchesError } = await supabase.from("registration_batches").select("id,name,sequence_number,max_confirmed_registrations").eq("event_id", resolved.event.id).order("sequence_number");
  if (batchesError) return reportError(batchesError.message);
  const batchIds = (batches ?? []).map((batch) => String(batch.id));

  const [{ data: prices, error: pricesError }, { data: orderItems, error: orderItemsError }] = await Promise.all([
    batchIds.length ? supabase.from("registration_batch_prices").select("batch_id,ticket_category_id,max_confirmed_registrations,ticket_categories(name)").in("batch_id", batchIds) : Promise.resolve({ data: [], error: null }),
    supabase.from("order_items").select("id,batch_id,ticket_category_id,status,orders!inner(status)").eq("event_id", resolved.event.id),
  ]);
  if (pricesError) return reportError(pricesError.message);
  if (orderItemsError) return reportError(orderItemsError.message);

  const confirmedByKey = new Map<string, number>();
  for (const item of orderItems ?? []) {
    if (!item.batch_id || String(item.status ?? "pending") !== "confirmed") continue;
    const order = Array.isArray(item.orders) ? item.orders[0] : item.orders;
    if (String(order?.status ?? "pending") !== "confirmed") continue;
    const key = `${item.batch_id}::${item.ticket_category_id ?? "__single__"}`;
    confirmedByKey.set(key, (confirmedByKey.get(key) ?? 0) + 1);
  }

  const batchNames = new Map((batches ?? []).map((batch) => [String(batch.id), String(batch.name)]));
  const rows = (prices ?? []).map((price) => {
    const category = Array.isArray(price.ticket_categories) ? price.ticket_categories[0] : price.ticket_categories;
    const key = `${price.batch_id}::${price.ticket_category_id}`;
    const confirmed = confirmedByKey.get(key) ?? 0;
    const limit = price.max_confirmed_registrations;
    return {
      lote: batchNames.get(String(price.batch_id)) ?? "-",
      categoria: category?.name ? String(category.name) : "-",
      confirmadas: confirmed,
      limite: limit != null ? String(limit) : "Sem limite",
      ocupacao: limit != null ? pct(confirmed, Number(limit)) : "-",
    };
  });
  const pricedBatchIds = new Set((prices ?? []).map((price) => String(price.batch_id)));
  for (const batch of batches ?? []) {
    const batchId = String(batch.id);
    const confirmed = confirmedByKey.get(`${batchId}::__single__`) ?? 0;
    if (pricedBatchIds.has(batchId) && confirmed === 0) continue;
    const limit = batch.max_confirmed_registrations;
    rows.push({
      lote: String(batch.name ?? "-"),
      categoria: "Ingresso único",
      confirmadas: confirmed,
      limite: limit != null ? String(limit) : "Sem limite",
      ocupacao: limit != null ? pct(confirmed, Number(limit)) : "-",
    });
  }

  const totalConfirmed = Array.from(confirmedByKey.values()).reduce((sum, count) => sum + count, 0);

  return reportSuccess({
    reportId: "eventos-ocupacao",
    title: "Ocupação por categoria e lote",
    subtitle: `Evento: ${resolved.event.name}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Lotes", value: String((batches ?? []).length) },
      { label: "Combinações categoria/lote", value: String(rows.length) },
      { label: "Total confirmado", value: String(totalConfirmed) },
    ],
    columns: [
      { key: "lote", label: "Lote" },
      { key: "categoria", label: "Categoria" },
      { key: "confirmadas", label: "Confirmadas", align: "right" },
      { key: "limite", label: "Limite", align: "right" },
      { key: "ocupacao", label: "Ocupação", align: "right" },
    ],
    rows,
  });
}

export async function eventosLotesHistorico(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  const { data, error } = await supabase
    .from("audit_logs")
    .select("action,actor,details,created_at")
    .eq("event_id", resolved.event.id)
    .in("action", BATCH_ACTIONS)
    .order("created_at", { ascending: false })
    .limit(2001);
  if (error) return reportError(error.message);

  const rows = (data ?? []).map((log) => {
    const details = (log.details ?? {}) as Record<string, unknown>;
    const batchName = details.batch_name ?? details.new_batch_name ?? details.name;
    return {
      data: formatDateTimeBR(String(log.created_at ?? "")),
      acao: BATCH_ACTION_LABELS[String(log.action ?? "")] ?? String(log.action ?? ""),
      lote: batchName ? String(batchName) : "-",
      operador: String(log.actor ?? "system"),
    };
  });

  return reportSuccess({
    reportId: "eventos-lotes-historico",
    title: "Histórico de avanço de lote",
    subtitle: `Evento: ${resolved.event.name} · ${rows.length} evento(s)`,
    generatedAt: new Date().toISOString(),
    summaryCards: [{ label: "Eventos registrados", value: String(rows.length) }],
    columns: [
      { key: "data", label: "Data" },
      { key: "acao", label: "Ação" },
      { key: "lote", label: "Lote" },
      { key: "operador", label: "Operador" },
    ],
    rows,
  });
}
