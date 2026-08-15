import type { ReportQueryContext, ReportResult, ReportSupabaseClient } from "../types";
import { dateRangeLabel, money, reportError, reportSuccess, resolveRequiredEvent } from "../helpers";
import { formatDateTimeBR } from "@/lib/utils/date";

const COUPON_TYPE_LABELS: Record<string, string> = { courtesy: "Cortesia", percentage: "Percentual" };

export async function cuponsUso(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  const [{ data: coupons, error: couponsError }, { data: redemptions, error: redemptionsError }] = await Promise.all([
    supabase.from("coupons").select("id,code,coupon_type,max_uses,used_count,is_active").eq("event_id", resolved.event.id).order("code"),
    supabase.from("coupon_redemptions").select("coupon_id,discount_amount").eq("event_id", resolved.event.id),
  ]);
  if (couponsError) return reportError(couponsError.message);
  if (redemptionsError) return reportError(redemptionsError.message);

  const discountByCoupon = new Map<string, number>();
  let totalDiscount = 0;
  for (const redemption of redemptions ?? []) {
    const couponId = String(redemption.coupon_id ?? "");
    const amount = Number(redemption.discount_amount ?? 0);
    discountByCoupon.set(couponId, (discountByCoupon.get(couponId) ?? 0) + amount);
    totalDiscount += amount;
  }

  const couponRows = coupons ?? [];
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
      tipo: COUPON_TYPE_LABELS[String(coupon.coupon_type ?? "")] ?? String(coupon.coupon_type ?? ""),
      usos: `${coupon.used_count ?? 0}${coupon.max_uses ? ` / ${coupon.max_uses}` : " (sem limite)"}`,
      desconto: money(discountByCoupon.get(String(coupon.id)) ?? 0),
    })),
  });
}

export async function cuponsResgates(supabase: ReportSupabaseClient, ctx: ReportQueryContext): Promise<ReportResult> {
  const resolved = await resolveRequiredEvent(supabase, ctx.eventId, ctx.organizationId);
  if ("error" in resolved) return reportError(resolved.error);

  let query = supabase
    .from("coupon_redemptions")
    .select("original_amount,discount_amount,final_amount,redeemed_at,coupons(code),participants(full_name)")
    .eq("event_id", resolved.event.id)
    .order("redeemed_at", { ascending: false })
    .limit(2001);
  if (ctx.dateFrom) query = query.gte("redeemed_at", `${ctx.dateFrom}T00:00:00`);
  if (ctx.dateTo) query = query.lte("redeemed_at", `${ctx.dateTo}T23:59:59`);
  const { data, error } = await query;
  if (error) return reportError(error.message);

  const rows = (data ?? []).map((redemption) => {
    const coupon = Array.isArray(redemption.coupons) ? redemption.coupons[0] : redemption.coupons;
    const participant = Array.isArray(redemption.participants) ? redemption.participants[0] : redemption.participants;
    return {
      cupom: coupon?.code ? String(coupon.code) : "-",
      participante: participant?.full_name ? String(participant.full_name) : "-",
      valor_original: money(Number(redemption.original_amount ?? 0)),
      desconto: money(Number(redemption.discount_amount ?? 0)),
      valor_final: money(Number(redemption.final_amount ?? 0)),
      resgatado_em: formatDateTimeBR(String(redemption.redeemed_at ?? "")),
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
