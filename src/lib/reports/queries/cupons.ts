import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { dateRangeLabel, money, reportError, reportSuccess, resolveRequiredEvent } from "../helpers";
import { formatDateTimeBR } from "@/lib/utils/date";

const DISCOUNT_TYPE_LABELS: Record<string, string> = { percentage: "Percentual", fixed: "Valor fixo" };

// Cupom agora pertence a organizacao (nao mais a 1 evento) -- "relevante
// para este evento" significa: sem nenhuma linha de escopo de evento (cupom
// vale pra toda a organizacao) OU com uma linha de escopo apontando
// especificamente para este evento. order_item_discounts (nao mais
// coupon_redemptions, que e legado/orfao e nunca era escrito pelo checkout
// real) e a fonte canonica de quanto foi de fato descontado.
export async function cuponsUso(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  const [{ data: allCoupons, error: couponsError }, { data: scopedCouponIds, error: scopeError }] = await Promise.all([
    supabase.from("coupons").select("id,code,discount_type,discount_value,max_uses,used_count,is_active").eq("organization_id", ctx.organizationId).order("code"),
    supabase.from("coupon_event_scopes").select("coupon_id").eq("event_id", resolved.event.id),
  ]);
  if (couponsError) return reportError(couponsError.message);
  if (scopeError) return reportError(scopeError.message);

  const eventScopedIds = new Set((scopedCouponIds ?? []).map((row) => String(row.coupon_id)));
  const { data: anyEventScope, error: anyScopeError } = await supabase.from("coupon_event_scopes").select("coupon_id");
  if (anyScopeError) return reportError(anyScopeError.message);
  const couponsWithAnyEventScope = new Set((anyEventScope ?? []).map((row) => String(row.coupon_id)));
  const couponRows = (allCoupons ?? []).filter((coupon) => !couponsWithAnyEventScope.has(String(coupon.id)) || eventScopedIds.has(String(coupon.id)));

  const { data: discountRows, error: discountError } = await supabase
    .from("order_item_discounts")
    .select("coupon_id,discount_amount,order_items!inner(event_id)")
    .eq("order_items.event_id", resolved.event.id);
  if (discountError) return reportError(discountError.message);

  const discountByCoupon = new Map<string, number>();
  let totalDiscount = 0;
  for (const row of discountRows ?? []) {
    const couponId = String(row.coupon_id ?? "");
    const amount = Number(row.discount_amount ?? 0);
    discountByCoupon.set(couponId, (discountByCoupon.get(couponId) ?? 0) + amount);
    totalDiscount += amount;
  }

  return reportSuccess({
    reportId: "cupons-uso",
    title: "Uso de cupons",
    subtitle: `Evento: ${resolved.event.name}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [
      { label: "Cupons cadastrados", value: String(couponRows.length) },
      { label: "Cupons ativos", value: String(couponRows.filter((coupon) => coupon.is_active).length) },
      { label: "Desconto total concedido", value: money(totalDiscount) },
    ],
    columns: [
      { key: "codigo", label: "Código" },
      { key: "tipo", label: "Tipo" },
      { key: "usos", label: "Usos" },
      { key: "desconto", label: "Desconto concedido", align: "right" },
    ],
    rows: couponRows.map((coupon) => ({
      codigo: String(coupon.code ?? ""),
      tipo: DISCOUNT_TYPE_LABELS[String(coupon.discount_type ?? "")] ?? String(coupon.discount_type ?? ""),
      usos: `${coupon.used_count ?? 0}${coupon.max_uses ? ` / ${coupon.max_uses}` : " (sem limite)"}`,
      desconto: money(discountByCoupon.get(String(coupon.id)) ?? 0),
    })),
  });
}

export async function cuponsResgates(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase
    .from("order_item_discounts")
    .select("coupon_code,base_amount,discount_amount,final_amount,created_at,order_items!inner(event_id,holder_full_name)")
    .eq("order_items.event_id", resolved.event.id)
    .order("created_at", { ascending: false })
    .limit(2001);
  if (ctx.dateFrom) query = query.gte("created_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("created_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const rows = (data ?? []).map((row) => {
    const orderItem = Array.isArray(row.order_items) ? row.order_items[0] : row.order_items;
    return {
      cupom: row.coupon_code ? String(row.coupon_code) : "-",
      participante: orderItem?.holder_full_name ? String(orderItem.holder_full_name) : "-",
      valor_original: money(Number(row.base_amount ?? 0)),
      desconto: money(Number(row.discount_amount ?? 0)),
      valor_final: money(Number(row.final_amount ?? 0)),
      resgatado_em: formatDateTimeBR(String(row.created_at ?? "")),
    };
  });

  return reportSuccess({
    reportId: "cupons-resgates",
    title: "Resgates de cupom",
    subtitle: `Evento: ${resolved.event.name} · ${rows.length} resgate(s)${dateRangeLabel(ctx.dateFrom, ctx.dateTo)}`,
    generatedAt: new Date().toISOString(),
    summaryCards: [{ label: "Resgates listados", value: String(rows.length) }],
    columns: [
      { key: "cupom", label: "Cupom" },
      { key: "participante", label: "Participante" },
      { key: "valor_original", label: "Valor original", align: "right" },
      { key: "desconto", label: "Desconto", align: "right" },
      { key: "valor_final", label: "Valor final", align: "right" },
      { key: "resgatado_em", label: "Resgatado em" },
    ],
    rows,
  });
}
