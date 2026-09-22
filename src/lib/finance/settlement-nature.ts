import { isLegacyImportPriceOrigin } from "../imports/legacy-price.ts";
import { resolveGatewayEnvironment } from "../payments/gateway-environment.ts";

export const SETTLEMENT_NATURES = [
  "gateway",
  "off_gateway",
  "courtesy",
  "coupon_zero",
  "legacy",
] as const;

export type SettlementNature = (typeof SETTLEMENT_NATURES)[number];

export type SettlementSource = {
  settlement_nature?: string | null;
  payment_method?: string | null;
  payment_status?: string | null;
  price_origin?: string | null;
  provider?: string | null;
  gateway_payment_id?: string | null;
  gateway_account_key?: string | null;
  gateway_environment?: string | null;
  amount?: number | null;
  discount_amount?: number | null;
  final_amount?: number | null;
  off_gateway_method?: string | null;
  off_gateway_amount?: number | null;
  off_gateway_received_at?: string | null;
  off_gateway_recorded_at?: string | null;
  off_gateway_recorded_by?: string | null;
  off_gateway_reason?: string | null;
  off_gateway_reference?: string | null;
  off_gateway_destination_note?: string | null;
  applied_coupon_percent?: number | null;
  has_full_coupon?: boolean | null;
};

function normalize(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

export function isSettlementNature(value: string | null | undefined): value is SettlementNature {
  return SETTLEMENT_NATURES.includes(normalize(value) as SettlementNature);
}

export function hasRealGatewayCharge(payment: SettlementSource) {
  const gatewayId = String(payment.gateway_payment_id ?? "").trim();
  if (!gatewayId || gatewayId.toLowerCase().startsWith("fake_")) return false;
  const provider = normalize(payment.provider);
  if (provider === "fake") return false;
  if (provider === "asaas") return true;
  if (payment.gateway_environment === "production" || payment.gateway_environment === "sandbox") return true;
  const account = String(payment.gateway_account_key ?? "").trim();
  return account === "asaas-conta-live-01" || account === "asaas-sandbox-militrin";
}

function hasFullCoupon(payment: SettlementSource) {
  if (payment.has_full_coupon) return true;
  const percent = Number(payment.applied_coupon_percent ?? NaN);
  return Number.isFinite(percent) && percent >= 100;
}

export function deriveSettlementNature(payment: SettlementSource): SettlementNature | null {
  if (String(payment.off_gateway_recorded_at ?? "").trim()) return "off_gateway";
  if (isSettlementNature(payment.settlement_nature)) return payment.settlement_nature as SettlementNature;

  const method = normalize(payment.payment_method);
  if (hasRealGatewayCharge(payment)) return "gateway";
  if (method === "courtesy" || method === "admin_courtesy") return "courtesy";
  if (isLegacyImportPriceOrigin(payment.price_origin)) return "legacy";

  const finalAmount = Number(payment.final_amount ?? 0);
  const amount = Number(payment.amount ?? 0);
  const discount = Number(payment.discount_amount ?? 0);
  if (finalAmount <= 0 && !hasRealGatewayCharge(payment) && (hasFullCoupon(payment) || (discount > 0 && discount >= amount))) {
    return "coupon_zero";
  }
  if ((method === "pix" || method === "credit_card" || method === "cash") && !hasRealGatewayCharge(payment) && finalAmount > 0) {
    return "legacy";
  }
  return null;
}

export function resolveSettlementNature(payment: SettlementSource): SettlementNature | null {
  if (String(payment.off_gateway_recorded_at ?? "").trim()) return "off_gateway";
  if (isSettlementNature(payment.settlement_nature)) return payment.settlement_nature as SettlementNature;
  return deriveSettlementNature(payment);
}

export function settlementNatureLabel(nature: SettlementNature | null | undefined) {
  if (nature === "gateway") return "Gateway";
  if (nature === "off_gateway") return "Fora do gateway";
  if (nature === "courtesy") return "Cortesia";
  if (nature === "coupon_zero") return "Cupom 100%";
  if (nature === "legacy") return "Legado";
  return "Não classificado";
}

export function formatSettlementMethodLabel(payment: SettlementSource) {
  const nature = resolveSettlementNature(payment);
  const method = normalize(payment.off_gateway_method) || normalize(payment.payment_method);
  if (nature === "off_gateway" && method === "pix") return "PIX · Fora do gateway";
  if (nature === "off_gateway") return `${method || "Pagamento"} · Fora do gateway`;
  if (nature === "coupon_zero") return "Cupom 100%";
  if (nature === "courtesy") return "Cortesia / emissão administrativa";
  if (nature === "legacy") return "Legado";
  if (nature === "gateway" && method === "pix") {
    return resolveGatewayEnvironment(payment) === "production" ? "PIX · Asaas" : "PIX · Asaas (sandbox)";
  }
  if (nature === "gateway" && method === "credit_card") {
    return resolveGatewayEnvironment(payment) === "production" ? "Cartão · Asaas" : "Cartão · Asaas (sandbox)";
  }
  if (method === "pix") return "PIX";
  if (method === "credit_card") return "Cartão";
  if (method === "cash") return "Dinheiro";
  if (method === "courtesy") return "Cortesia / emissão administrativa";
  return method || "Não informado";
}

export function settlementDisplayAmount(payment: SettlementSource) {
  if (resolveSettlementNature(payment) === "off_gateway") {
    return Number(payment.off_gateway_amount ?? 0);
  }
  return Number(payment.final_amount ?? 0);
}

export const SALES_SETTLEMENT_FILTERS = [
  "pix_asaas",
  "pix_off_gateway",
  "card_asaas",
  "courtesy",
  "coupon_zero",
  "legacy",
] as const;

export type SalesSettlementFilter = (typeof SALES_SETTLEMENT_FILTERS)[number];

export function salesSettlementFilterLabel(filter: SalesSettlementFilter) {
  if (filter === "pix_asaas") return "PIX · Asaas";
  if (filter === "pix_off_gateway") return "PIX · Fora do gateway";
  if (filter === "card_asaas") return "Cartão · Asaas";
  if (filter === "courtesy") return "Cortesia";
  if (filter === "coupon_zero") return "Cupom 100%";
  return "Legado";
}

export function matchesSalesSettlementFilter(payment: SettlementSource, filter: SalesSettlementFilter) {
  const nature = resolveSettlementNature(payment);
  const method = normalize(payment.off_gateway_method) || normalize(payment.payment_method);
  if (filter === "pix_asaas") return nature === "gateway" && method === "pix";
  if (filter === "pix_off_gateway") return nature === "off_gateway" && method === "pix";
  if (filter === "card_asaas") return nature === "gateway" && method === "credit_card";
  if (filter === "courtesy") return nature === "courtesy";
  if (filter === "coupon_zero") return nature === "coupon_zero";
  return nature === "legacy";
}

export function canRegisterOffGatewayPayment(payment: SettlementSource) {
  const nature = resolveSettlementNature(payment);
  if (hasRealGatewayCharge(payment) || nature === "gateway") {
    return { allowed: false, replace: false, reason: "Este pagamento tem cobrança no gateway integrado e não pode ser convertido para fora do gateway." };
  }
  if (nature === "coupon_zero") {
    return { allowed: false, replace: false, reason: "Cupom 100% não é pagamento recebido fora do gateway." };
  }
  const status = normalize(payment.payment_status);
  if (status === "pending" || status === "expired" || status === "cancelled" || status === "canceled") {
    return { allowed: false, replace: false, reason: "Regularização fora do gateway nesta versão só se aplica a pagamento já pago, sem emitir ingresso." };
  }
  if (nature === "off_gateway") {
    return { allowed: true, replace: true, reason: null };
  }
  if (status === "paid") {
    return { allowed: true, replace: false, reason: null };
  }
  return { allowed: false, replace: false, reason: "Este pagamento não pode ser regularizado fora do gateway." };
}
