import { resolveCommercialStatus, resolvePaymentDisplayStatus, type CommercialStatus } from "../dashboard/commercial-status.ts";
import { formatDisplayNumber, orderDisplayReference } from "../display-reference.ts";
import {
  formatSettlementMethodLabel,
  hasRealGatewayCharge,
  resolveSettlementNature,
  settlementDisplayAmount,
  type SettlementSource,
} from "../finance/settlement-nature.ts";
import { formatImportedPaymentMethod } from "../imports/payment-method.ts";
import { resolvePixCommercialExpiresAt } from "../payments/pix-due-date.ts";
import { resolveCouponUsagePaymentView, type CouponUsageRow } from "../coupons/usage.ts";
import { orderChargeBreakdown } from "./charge-breakdown.ts";

export const ORDER_ORIGIN_LABELS: Record<string, string> = {
  imported_holder: "Importado",
  administrative: "Emitido pelo operador",
  account: "Compra pelo site",
};

export const COUPON_NOT_PAYMENT_COPY =
  "A aplicação do cupom não significa que o pedido foi pago.";

export type SupportSituationBadge =
  | "paid"
  | "pending"
  | "expired"
  | "cancelled"
  | "refunded"
  | "courtesy"
  | "coupon_zero"
  | "off_gateway"
  | "confirmed"
  | "error";

export type SupportPaymentInput = {
  payment_status?: string | null;
  payment_method?: string | null;
  paid_at?: string | null;
  payment_paid_at?: string | null;
  created_at?: string | null;
  expires_at?: string | null;
  amount?: number | null;
  final_amount?: number | null;
  payment_final_amount?: number | null;
  payment_fee_customer_amount?: number | null;
  settlement_nature?: string | null;
  provider?: string | null;
  gateway_payment_id?: string | null;
  gateway_account_key?: string | null;
  gateway_environment?: string | null;
  off_gateway_method?: string | null;
  off_gateway_amount?: number | null;
  off_gateway_recorded_at?: string | null;
  price_origin?: string | null;
};

export type SupportOrderInput = {
  orderId: string;
  displayNumber?: number | null;
  orderNumber?: string | null;
  orderStatus?: string | null;
  buyerType?: string | null;
  baseAmount?: number | null;
  discountAmount?: number | null;
  finalAmount?: number | null;
  priceOrigin?: string | null;
  couponCode?: string | null;
  reservationExpiresAt?: string | null;
  createdAt?: string | null;
  payment?: SupportPaymentInput | null;
  now?: Date;
};

export type SupportOrderPresentation = {
  orderId: string;
  orderNumber: string;
  commercialStatus: CommercialStatus;
  situationBadge: SupportSituationBadge;
  originLabel: string;
  couponCode: string | null;
  originalAmount: number;
  discountAmount: number;
  afterDiscountAmount: number;
  customerFee: number;
  chargedAmount: number | null;
  paidAmount: number | null;
  isPaid: boolean;
  methodLabel: string;
  formaLabel: string;
  gatewayLabel: string;
  paymentStatus: string | null;
  paymentDisplayStatus: string;
  paymentCreatedAt: string | null;
  paidAt: string | null;
  expiredAt: string | null;
  couponDoesNotMeanPaid: boolean;
  createdAt: string | null;
};

export function orderOriginLabel(buyerType: string | null | undefined) {
  const key = String(buyerType ?? "");
  return ORDER_ORIGIN_LABELS[key] ?? "Não informada";
}

function moneyNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function settlementSourceFrom(input: SupportOrderInput): SettlementSource {
  const payment = input.payment ?? {};
  return {
    settlement_nature: payment.settlement_nature,
    payment_method: payment.payment_method,
    payment_status: payment.payment_status,
    price_origin: payment.price_origin ?? input.priceOrigin,
    provider: payment.provider,
    gateway_payment_id: payment.gateway_payment_id,
    gateway_account_key: payment.gateway_account_key,
    gateway_environment: payment.gateway_environment,
    amount: payment.amount ?? input.baseAmount,
    discount_amount: input.discountAmount,
    final_amount: payment.payment_final_amount ?? payment.final_amount ?? input.finalAmount,
    off_gateway_method: payment.off_gateway_method,
    off_gateway_amount: payment.off_gateway_amount,
    off_gateway_recorded_at: payment.off_gateway_recorded_at,
  };
}

function commercialExpiresAt(input: SupportOrderInput) {
  const payment = input.payment;
  return resolvePixCommercialExpiresAt({
    expiresAt: payment?.expires_at ?? input.reservationExpiresAt,
    paymentCreatedAt: payment?.created_at,
    paymentMethod: payment?.payment_method,
  }) ?? input.reservationExpiresAt ?? null;
}

function gatewayLabel(source: SettlementSource, nature: ReturnType<typeof resolveSettlementNature>) {
  if (nature === "off_gateway") return "Fora do gateway";
  if (nature === "courtesy" || nature === "coupon_zero") return "—";
  const provider = String(source.provider ?? "").trim().toLowerCase();
  if (provider === "asaas" || hasRealGatewayCharge(source) || nature === "gateway") return "Asaas";
  return "—";
}

function toCouponUsageRow(input: SupportOrderInput, expiresAt: string | null): CouponUsageRow {
  const payment = input.payment ?? {};
  return {
    order_id: input.orderId,
    display_number: input.displayNumber ?? null,
    order_number: input.orderNumber ?? null,
    order_status: input.orderStatus ?? null,
    buyer_type: input.buyerType ?? null,
    user_id: null,
    contact_id: null,
    contact_name: null,
    contact_email: null,
    buyer_name: null,
    buyer_email: null,
    applied_at: null,
    original_amount: input.baseAmount ?? null,
    discount_amount: input.discountAmount ?? null,
    after_discount_amount: input.finalAmount ?? null,
    payment_status: payment.payment_status ?? null,
    payment_method: payment.payment_method ?? null,
    payment_paid_at: payment.paid_at ?? payment.payment_paid_at ?? null,
    payment_final_amount: payment.payment_final_amount ?? payment.final_amount ?? null,
    payment_fee_customer_amount: payment.payment_fee_customer_amount ?? null,
    settlement_nature: payment.settlement_nature ?? null,
    provider: payment.provider ?? null,
    gateway_payment_id: payment.gateway_payment_id ?? null,
    gateway_account_key: payment.gateway_account_key ?? null,
    gateway_environment: payment.gateway_environment ?? null,
    off_gateway_method: payment.off_gateway_method ?? null,
    off_gateway_amount: payment.off_gateway_amount ?? null,
    off_gateway_recorded_at: payment.off_gateway_recorded_at ?? null,
    reservation_expires_at: expiresAt,
    price_origin: payment.price_origin ?? input.priceOrigin ?? null,
  };
}

export function presentSupportOrder(input: SupportOrderInput): SupportOrderPresentation {
  const payment = input.payment ?? null;
  const source = settlementSourceFrom(input);
  const nature = resolveSettlementNature(source);
  const expiresAt = commercialExpiresAt(input);
  const commercialStatus = resolveCommercialStatus({
    orderStatus: input.orderStatus,
    paymentStatus: payment?.payment_status,
    reservationExpiresAt: expiresAt,
    now: input.now,
  });
  const paymentDisplayStatus = resolvePaymentDisplayStatus({
    commercialStatus,
    paymentStatus: payment?.payment_status,
  });
  const paymentView = resolveCouponUsagePaymentView(toCouponUsageRow(input, expiresAt));
  const charge = orderChargeBreakdown({
    itemsAmount: input.finalAmount,
    customerFee: payment?.payment_fee_customer_amount,
    chargedAmount: payment?.payment_final_amount ?? payment?.final_amount,
  });
  const couponCode = String(input.couponCode ?? "").trim() || null;
  const hasFinancialCharge = nature !== "courtesy" && nature !== "coupon_zero";

  return {
    orderId: input.orderId,
    orderNumber: formatDisplayNumber(input.displayNumber) ?? orderDisplayReference(input.displayNumber, input.orderNumber),
    commercialStatus,
    situationBadge: nature === "off_gateway" ? "off_gateway" : paymentView.badge,
    originLabel: orderOriginLabel(input.buyerType),
    couponCode,
    originalAmount: moneyNumber(input.baseAmount),
    discountAmount: moneyNumber(input.discountAmount),
    afterDiscountAmount: moneyNumber(input.finalAmount),
    customerFee: charge.customerFee,
    chargedAmount: !hasFinancialCharge
      ? null
      : nature === "off_gateway"
        ? settlementDisplayAmount(source)
        : charge.chargedAmount,
    paidAmount: paymentView.paidAmount,
    isPaid: paymentView.isPaid,
    methodLabel: payment?.payment_method || payment?.off_gateway_method
      ? formatSettlementMethodLabel(source)
      : formatImportedPaymentMethod(payment?.payment_method),
    formaLabel: formatImportedPaymentMethod(payment?.off_gateway_method || payment?.payment_method),
    gatewayLabel: gatewayLabel(source, nature),
    paymentStatus: payment?.payment_status ?? null,
    paymentDisplayStatus,
    paymentCreatedAt: payment?.created_at ?? null,
    paidAt: paymentView.paidAt,
    expiredAt: commercialStatus === "expired" ? expiresAt : null,
    couponDoesNotMeanPaid: Boolean(couponCode),
    createdAt: input.createdAt ?? null,
  };
}

export function summarizeSupportOrders(orders: SupportOrderPresentation[]) {
  const counts = { paid: 0, pending: 0, expired: 0, courtesy: 0, couponZero: 0, offGateway: 0, cancelled: 0 };
  for (const order of orders) {
    if (order.situationBadge === "paid" || order.situationBadge === "confirmed") counts.paid += 1;
    else if (order.situationBadge === "pending") counts.pending += 1;
    else if (order.situationBadge === "expired") counts.expired += 1;
    else if (order.situationBadge === "courtesy") counts.courtesy += 1;
    else if (order.situationBadge === "coupon_zero") counts.couponZero += 1;
    else if (order.situationBadge === "off_gateway") counts.offGateway += 1;
    else counts.cancelled += 1;
  }
  return { total: orders.length, ...counts };
}

export function latestPaymentRow<T extends { created_at?: string | null }>(payments: T | T[] | null | undefined): T | null {
  const rows = Array.isArray(payments) ? payments : payments ? [payments] : [];
  if (!rows.length) return null;
  return rows.slice().sort((a, b) => {
    const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
    return bTime - aTime;
  })[0] ?? null;
}

export function presentSupportOrderFromRecord(
  row: Record<string, unknown>,
  extras?: { couponCode?: string | null; now?: Date },
): SupportOrderPresentation {
  const payment = latestPaymentRow(row.payments as SupportPaymentInput | SupportPaymentInput[] | null | undefined);
  const couponRelation = row.coupons as { code?: string | null } | { code?: string | null }[] | null | undefined;
  const couponFromRelation = Array.isArray(couponRelation) ? couponRelation[0]?.code : couponRelation?.code;
  return presentSupportOrder({
    orderId: String(row.id ?? ""),
    displayNumber: row.display_number as number | null | undefined,
    orderNumber: row.order_number as string | null | undefined,
    orderStatus: row.status as string | null | undefined,
    buyerType: row.buyer_type as string | null | undefined,
    baseAmount: row.base_amount as number | null | undefined,
    discountAmount: row.discount_amount as number | null | undefined,
    finalAmount: row.final_amount as number | null | undefined,
    priceOrigin: row.price_origin as string | null | undefined,
    couponCode: extras?.couponCode ?? (couponFromRelation ? String(couponFromRelation) : null),
    reservationExpiresAt: row.reservation_expires_at as string | null | undefined,
    createdAt: row.created_at as string | null | undefined,
    payment,
    now: extras?.now,
  });
}
