import { resolveCommercialStatus } from "../dashboard/commercial-status.ts";
import { formatDisplayNumber, orderDisplayReference } from "../display-reference.ts";
import {
  formatSettlementMethodLabel,
  resolveSettlementNature,
  settlementDisplayAmount,
  type SettlementSource,
} from "../finance/settlement-nature.ts";
import { formatImportedPaymentMethod } from "../imports/payment-method.ts";

export const UNIDENTIFIED_CADASTRO_LABEL = "Cadastro não identificado";

export type CouponUsagePaymentBadge =
  | "paid"
  | "pending"
  | "expired"
  | "cancelled"
  | "refunded"
  | "error"
  | "courtesy"
  | "coupon_zero";

export type CouponUsageRow = {
  order_id: string;
  display_number: number | null;
  order_number: string | null;
  order_status: string | null;
  buyer_type: string | null;
  user_id: string | null;
  contact_id: string | null;
  contact_name: string | null;
  contact_email: string | null;
  buyer_name: string | null;
  buyer_email: string | null;
  applied_at: string | null;
  original_amount: number | null;
  discount_amount: number | null;
  after_discount_amount: number | null;
  payment_status: string | null;
  payment_method: string | null;
  payment_paid_at: string | null;
  payment_final_amount: number | null;
  payment_fee_customer_amount: number | null;
  settlement_nature: string | null;
  provider: string | null;
  gateway_payment_id: string | null;
  gateway_account_key: string | null;
  gateway_environment: string | null;
  off_gateway_method: string | null;
  off_gateway_amount: number | null;
  off_gateway_recorded_at: string | null;
  reservation_expires_at: string | null;
  price_origin: string | null;
};

export type CouponUsagePaymentView = {
  badge: CouponUsagePaymentBadge;
  methodLabel: string;
  isPaid: boolean;
  paidAt: string | null;
  paidAmount: number | null;
};

export type CouponUsagePresentation = {
  orderId: string;
  orderNumber: string;
  cadastroId: string | null;
  cadastroName: string;
  cadastroEmail: string | null;
  cadastroIdentified: boolean;
  buyerFallbackName: string | null;
  originalAmount: number;
  discountAmount: number;
  afterDiscountAmount: number;
  appliedAt: string | null;
  consumesLimit: true;
  payment: CouponUsagePaymentView;
};

export function formatCouponUsesLabel(usedCount: number | null | undefined, maxUses: number | null | undefined) {
  const used = Number(usedCount ?? 0);
  if (maxUses == null) return `${used} / ilimitado`;
  return `${used} / ${maxUses}`;
}

export function remainingCouponUses(usedCount: number | null | undefined, maxUses: number | null | undefined) {
  if (maxUses == null) return null;
  return Math.max(0, Number(maxUses) - Number(usedCount ?? 0));
}

export function couponHasRecordedUses(usedCount: number | null | undefined) {
  return Number(usedCount ?? 0) > 0;
}

function settlementSourceFromUsage(row: CouponUsageRow): SettlementSource {
  return {
    settlement_nature: row.settlement_nature,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    price_origin: row.price_origin,
    provider: row.provider,
    gateway_payment_id: row.gateway_payment_id,
    gateway_account_key: row.gateway_account_key,
    gateway_environment: row.gateway_environment,
    amount: row.original_amount,
    discount_amount: row.discount_amount,
    final_amount: row.payment_final_amount ?? row.after_discount_amount,
    off_gateway_method: row.off_gateway_method,
    off_gateway_amount: row.off_gateway_amount,
    off_gateway_recorded_at: row.off_gateway_recorded_at,
  };
}

function normalizePaymentStatus(status: string | null | undefined) {
  const raw = String(status ?? "").trim().toLowerCase();
  if (raw === "canceled") return "cancelled";
  if (raw === "processing") return "pending";
  if (raw === "error" || raw === "failed") return "failed";
  return raw;
}

export function resolveCouponUsagePaymentView(row: CouponUsageRow): CouponUsagePaymentView {
  const source = settlementSourceFromUsage(row);
  const nature = resolveSettlementNature(source);
  const paymentStatus = normalizePaymentStatus(row.payment_status);
  const commercial = resolveCommercialStatus({
    orderStatus: row.order_status,
    paymentStatus: row.payment_status,
    reservationExpiresAt: row.reservation_expires_at,
  });

  const methodLabel = row.payment_method || row.off_gateway_method
    ? formatSettlementMethodLabel(source)
    : formatImportedPaymentMethod(row.payment_method);

  if (nature === "courtesy") {
    return { badge: "courtesy", methodLabel, isPaid: false, paidAt: null, paidAmount: null };
  }
  if (nature === "coupon_zero") {
    return { badge: "coupon_zero", methodLabel, isPaid: false, paidAt: null, paidAmount: null };
  }

  let badge: CouponUsagePaymentBadge = "pending";
  if (paymentStatus === "refunded") badge = "refunded";
  else if (paymentStatus === "paid" || commercial === "confirmed") badge = "paid";
  else if (paymentStatus === "expired" || commercial === "expired") badge = "expired";
  else if (paymentStatus === "cancelled" || commercial === "cancelled") badge = "cancelled";
  else if (paymentStatus === "failed") badge = "error";

  const isPaid = paymentStatus === "paid";
  return {
    badge,
    methodLabel,
    isPaid,
    paidAt: isPaid ? row.payment_paid_at : null,
    paidAmount: isPaid ? settlementDisplayAmount(source) : null,
  };
}

export function presentCouponUsage(row: CouponUsageRow): CouponUsagePresentation {
  const cadastroIdentified = Boolean(row.contact_id);
  const cadastroName = cadastroIdentified
    ? String(row.contact_name || row.buyer_name || UNIDENTIFIED_CADASTRO_LABEL)
    : UNIDENTIFIED_CADASTRO_LABEL;
  const cadastroEmail = cadastroIdentified
    ? (row.contact_email || row.buyer_email || null)
    : (row.buyer_email || null);
  const buyerFallbackName = !cadastroIdentified && row.buyer_name ? String(row.buyer_name) : null;

  return {
    orderId: row.order_id,
    orderNumber: formatDisplayNumber(row.display_number) ?? orderDisplayReference(row.display_number, row.order_number),
    cadastroId: row.contact_id,
    cadastroName,
    cadastroEmail,
    cadastroIdentified,
    buyerFallbackName,
    originalAmount: Number(row.original_amount ?? 0),
    discountAmount: Number(row.discount_amount ?? 0),
    afterDiscountAmount: Number(row.after_discount_amount ?? 0),
    appliedAt: row.applied_at,
    consumesLimit: true,
    payment: resolveCouponUsagePaymentView(row),
  };
}
