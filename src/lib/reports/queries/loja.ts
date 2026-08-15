import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { dateRangeLabel, money, reportError, reportSuccess, resolveOptionalEvent } from "../helpers";
import { formatDateTimeBR } from "@/lib/utils/date";

const ORDER_STATUS_LABELS: Record<string, string> = { pending: "Pendente", confirmed: "Confirmado", cancelled: "Cancelado", expired: "Expirado" };
const ITEM_STATUS_LABELS: Record<string, string> = { reserved: "Reservado", confirmed: "Confirmado", delivered: "Entregue", cancelled: "Cancelado" };

export async function lojaFaturamento(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveOptionalEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let ordersQuery = supabase.from("store_orders").select("id,final_amount,payment_status,status,created_at").eq("organization_id", ctx.organizationId);
  if (resolved.event) ordersQuery = ordersQuery.eq("event_id", resolved.event.id);
  if (ctx.dateFrom) ordersQuery = ordersQuery.gte("created_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) ordersQuery = ordersQuery.lte("created_at", `${ctx.dateTo}T23:59:59`);
  const { data: orders, error: ordersError } = await ordersQuery;
  if (ordersError) return reportError(ordersError.message);

  const orderRows = orders ?? [];
  const revenue = orderRows.filter((order) => order.payment_status === "paid").reduce((sum, order) => sum + Number(order.final_amount ?? 0), 0);
  const cancelled = orderRows.filter((order) => order.status === "cancelled").length;
  const orderIds = orderRows.map((order) => String(order.id));

  const itemTotals = new Map<string, number>();
  if (orderIds.length > 0) {
    const { data: items } = await supabase.from("store_order_items").select("quantity,status,store_items(name)").in("store_order_id", orderIds).neq("status", "cancelled");
    for (const item of items ?? []) {
      const storeItem = Array.isArray(item.store_items) ? item.store_items[0] : item.store_items;
      const name = storeItem?.name ? String(storeItem.name) : "Item";
      itemTotals.set(name, (itemTotals.get(name) ?? 0) + Number(item.quantity ?? 0));
    }
  }

  return reportSuccess({
    reportId: "loja-faturamento",
    title: "Faturamento da loja e itens mais vendidos",
    subtitle: `${resolved.event ? `Evento: ${resolved.event.name}` : "Todos os eventos"}${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Faturamento (pago)", value: money(revenue) },
      { label: "Pedidos no período", value: String(orderRows.length) },
      { label: "Pedidos cancelados", value: String(cancelled) },
    ],
    columns: [
      { key: "item", label: "Item" },
      { key: "quantidade", label: "Quantidade vendida", align: "right" },
    ],
    rows: Array.from(itemTotals, ([item, quantidade]) => ({ item, quantidade })).sort((a, b) => b.quantidade - a.quantidade),
  });
}

export async function lojaPedidos(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveOptionalEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase
    .from("store_order_items")
    .select("quantity,status,delivered_at,store_items(name),store_orders!inner(order_number,status,created_at,organization_id,event_id)")
    .eq("store_orders.organization_id", ctx.organizationId)
    .order("delivered_at", { ascending: false })
    .limit(2001);
  if (resolved.event) query = query.eq("store_orders.event_id", resolved.event.id);
  if (ctx.dateFrom) query = query.gte("store_orders.created_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("store_orders.created_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const rows = (data ?? []).map((item) => {
    const storeItem = Array.isArray(item.store_items) ? item.store_items[0] : item.store_items;
    const order = Array.isArray(item.store_orders) ? item.store_orders[0] : item.store_orders;
    return {
      pedido: order?.order_number ? String(order.order_number) : "-",
      status_pedido: order?.status ? ORDER_STATUS_LABELS[String(order.status)] ?? String(order.status) : "-",
      item: storeItem?.name ? String(storeItem.name) : "Item",
      quantidade: Number(item.quantity ?? 0),
      status_entrega: ITEM_STATUS_LABELS[String(item.status ?? "")] ?? String(item.status ?? ""),
      entregue_em: item.delivered_at ? formatDateTimeBR(String(item.delivered_at)) : "-",
    };
  });

  return reportSuccess({
    reportId: "loja-pedidos",
    title: "Pedidos da loja",
    subtitle: `${resolved.event ? `Evento: ${resolved.event.name}` : "Todos os eventos"} · ${rows.length} item(ns)${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [{ label: "Itens listados", value: String(rows.length) }],
    columns: [
      { key: "pedido", label: "Pedido" },
      { key: "status_pedido", label: "Status do pedido" },
      { key: "item", label: "Item" },
      { key: "quantidade", label: "Quantidade", align: "right" },
      { key: "status_entrega", label: "Status de entrega" },
      { key: "entregue_em", label: "Entregue em" },
    ],
    rows,
  });
}
