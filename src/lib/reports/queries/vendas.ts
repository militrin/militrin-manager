import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { dateRangeLabel, money, pct, reportError, reportSuccess, resolveRequiredEvent } from "../helpers";
import { formatDateTimeBR } from "@/lib/utils/date";
import { orderDisplayReference } from "@/lib/display-reference";

const STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  confirmed: "Confirmado",
  expired: "Expirado",
  cancelled: "Cancelado",
  refunded: "Estornado",
};

export async function vendasFunil(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase.from("orders").select("status,final_amount,created_at").eq("event_id", resolved.event.id);
  if (ctx.dateFrom) query = query.gte("created_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("created_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const orders = data ?? [];
  const total = orders.length;
  const byStatus = new Map<string, number>();
  let revenueSum = 0;
  let revenueCount = 0;
  for (const order of orders) {
    const status = String(order.status ?? "pending");
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    if (status === "confirmed" && order.final_amount != null) {
      revenueSum += Number(order.final_amount);
      revenueCount += 1;
    }
  }
  const cancelled = byStatus.get("cancelled") ?? 0;
  const expired = byStatus.get("expired") ?? 0;
  const avgTicket = revenueCount ? revenueSum / revenueCount : 0;

  return reportSuccess({
    reportId: "vendas-funil",
    title: "Funil de vendas e ticket médio",
    subtitle: `Evento: ${resolved.event.name}${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Total de pedidos", value: String(total) },
      { label: "Ticket médio (confirmados)", value: money(avgTicket) },
      { label: "Taxa de cancelamento", value: pct(cancelled, total) },
      { label: "Taxa de expiração", value: pct(expired, total) },
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

export async function vendasPedidos(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase
    .from("orders")
    .select("order_number,display_number,status,final_amount,created_at,participants(full_name,cpf),payments(payment_method)")
    .eq("event_id", resolved.event.id)
    .order("created_at", { ascending: false })
    .limit(2001);
  if (ctx.dateFrom) query = query.gte("created_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("created_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const rows = (data ?? []).map((order) => {
    const participant = Array.isArray(order.participants) ? order.participants[0] : order.participants;
    const payment = Array.isArray(order.payments) ? order.payments[0] : order.payments;
    return {
      pedido: orderDisplayReference(order.display_number, order.order_number),
      status: STATUS_LABELS[String(order.status ?? "")] ?? String(order.status ?? ""),
      comprador: participant?.full_name ? String(participant.full_name) : "Sem titular definido",
      valor: money(Number(order.final_amount ?? 0)),
      pagamento: payment?.payment_method ? String(payment.payment_method) : "-",
      criado_em: formatDateTimeBR(String(order.created_at ?? "")),
    };
  });

  return reportSuccess({
    reportId: "vendas-pedidos",
    title: "Lista de pedidos",
    subtitle: `Evento: ${resolved.event.name} · ${rows.length} pedido(s)${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [{ label: "Pedidos listados", value: String(rows.length) }],
    columns: [
      { key: "pedido", label: "Pedido" },
      { key: "status", label: "Status" },
      { key: "comprador", label: "Comprador" },
      { key: "valor", label: "Valor final", align: "right" },
      { key: "pagamento", label: "Forma de pagamento" },
      { key: "criado_em", label: "Criado em" },
    ],
    rows,
  });
}
