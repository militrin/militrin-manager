import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { dateRangeLabel, reportError, reportSuccess, resolveRequiredEvent } from "../helpers";
import { formatDateTimeBR } from "@/lib/utils/date";

const MOVEMENT_LABELS: Record<string, string> = {
  purchase: "Encomenda",
  adjustment: "Ajuste",
  return: "Devolução",
  loss: "Perda",
};
const INVENTORY_ACTIONS = ["inventory_quantity_added", "inventory_quantity_adjusted"];

export async function estoqueSaldo(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  const { data, error } = await supabase
    .from("shirt_inventory")
    .select("shirt_type,shirt_size,total_quantity,reserved_quantity,delivered_quantity")
    .eq("event_id", resolved.event.id)
    .order("shirt_type")
    .order("shirt_size");
  if (error) return reportError(error.message);

  const rows = data ?? [];
  const totalReceived = rows.reduce((sum, row) => sum + Number(row.total_quantity ?? 0), 0);
  const totalDelivered = rows.reduce((sum, row) => sum + Number(row.delivered_quantity ?? 0), 0);
  const totalAvailable = rows.reduce((sum, row) => sum + (Number(row.total_quantity ?? 0) - Number(row.reserved_quantity ?? 0) - Number(row.delivered_quantity ?? 0)), 0);

  return reportSuccess({
    reportId: "estoque-saldo",
    title: "Saldo disponível por modelo e tamanho",
    subtitle: `Evento: ${resolved.event.name}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Total recebido", value: String(totalReceived) },
      { label: "Total entregue", value: String(totalDelivered) },
      { label: "Total disponível", value: String(totalAvailable) },
    ],
    columns: [
      { key: "modelo", label: "Modelo" },
      { key: "tamanho", label: "Tamanho" },
      { key: "total", label: "Total", align: "right" },
      { key: "reservadas", label: "Reservadas", align: "right" },
      { key: "entregues", label: "Entregues", align: "right" },
      { key: "disponiveis", label: "Disponíveis", align: "right" },
    ],
    rows: rows.map((row) => ({
      modelo: String(row.shirt_type ?? ""),
      tamanho: String(row.shirt_size ?? ""),
      total: Number(row.total_quantity ?? 0),
      reservadas: Number(row.reserved_quantity ?? 0),
      entregues: Number(row.delivered_quantity ?? 0),
      disponiveis: Number(row.total_quantity ?? 0) - Number(row.reserved_quantity ?? 0) - Number(row.delivered_quantity ?? 0),
    })),
  });
}

export async function estoqueMovimentacoes(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase
    .from("inventory_movements")
    .select("id,movement_type,quantity,notes,created_at,shirt_inventory(shirt_type,shirt_size)")
    .eq("event_id", resolved.event.id)
    .order("created_at", { ascending: false })
    .limit(2001);
  if (ctx.dateFrom) query = query.gte("created_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("created_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const { data: auditRows } = await supabase.from("audit_logs").select("entity_id,actor").eq("event_id", resolved.event.id).in("action", INVENTORY_ACTIONS);
  const operatorByMovement = new Map<string, string>();
  for (const row of auditRows ?? []) {
    const entityId = String(row.entity_id ?? "");
    if (!entityId) continue;
    operatorByMovement.set(entityId, String(row.actor ?? "Não informado"));
  }

  const rows = (data ?? []).map((movement) => {
    const inventory = Array.isArray(movement.shirt_inventory) ? movement.shirt_inventory[0] : movement.shirt_inventory;
    return {
      data: formatDateTimeBR(String(movement.created_at ?? "")),
      tipo: MOVEMENT_LABELS[String(movement.movement_type ?? "")] ?? String(movement.movement_type ?? ""),
      modelo: inventory?.shirt_type ? String(inventory.shirt_type) : "-",
      tamanho: inventory?.shirt_size ? String(inventory.shirt_size) : "-",
      quantidade: Number(movement.quantity ?? 0),
      motivo: movement.notes ? String(movement.notes) : "-",
      operador: operatorByMovement.get(String(movement.id)) ?? "Não identificado",
    };
  });

  return reportSuccess({
    reportId: "estoque-movimentacoes",
    title: "Movimentações de estoque",
    subtitle: `Evento: ${resolved.event.name} · ${rows.length} movimentação(ões)${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [{ label: "Movimentações listadas", value: String(rows.length) }],
    columns: [
      { key: "data", label: "Data" },
      { key: "tipo", label: "Tipo" },
      { key: "modelo", label: "Modelo" },
      { key: "tamanho", label: "Tamanho" },
      { key: "quantidade", label: "Quantidade", align: "right" },
      { key: "motivo", label: "Motivo" },
      { key: "operador", label: "Operador" },
    ],
    rows,
  });
}
