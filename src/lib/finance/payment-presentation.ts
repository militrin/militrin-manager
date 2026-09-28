import { confirmedRevenueAmount, shouldIncludeInConfirmedRevenue } from "./confirmed-revenue.ts";
import {
  canRegisterOffGatewayPayment,
  formatSettlementMethodLabel,
  resolveSettlementNature,
  settlementDisplayAmount,
  type SettlementSource,
} from "./settlement-nature.ts";

export type FinanceLiquidationBadge =
  | "paid"
  | "pending"
  | "expired"
  | "cancelled"
  | "refunded"
  | "courtesy"
  | "coupon_zero"
  | "off_gateway";

export type FinancePaymentPresentation = {
  badge: FinanceLiquidationBadge;
  statusLabel: string;
  methodLabel: string;
  moneyEntered: boolean;
  isRevenue: boolean;
  displayAmount: number | null;
  amountCaption: string;
  whenIso: string | null;
};

type FinancePaymentSource = SettlementSource & {
  payment_status?: string | null;
  refund_status?: string | null;
  paid_at?: string | null;
  off_gateway_received_at?: string | null;
};

function normalize(value: string | null | undefined) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "canceled") return "cancelled";
  return raw;
}

export function financeSalesStatusFilterLabel(status: "pending" | "paid" | "cancelled" | "expired" | "refunded" | "courtesy") {
  if (status === "paid") return "Pagos";
  if (status === "pending") return "Pendentes";
  if (status === "cancelled") return "Cancelados";
  if (status === "expired") return "Expirados";
  if (status === "refunded") return "Estornados";
  return "Cortesias";
}

export function presentFinancePayment(payment: FinancePaymentSource): FinancePaymentPresentation {
  const status = normalize(payment.payment_status);
  const refund = normalize(payment.refund_status);
  const nature = resolveSettlementNature(payment);
  const methodLabel = formatSettlementMethodLabel(payment);
  const isRevenue = shouldIncludeInConfirmedRevenue(payment);

  if (status === "refunded" || refund === "completed") {
    return {
      badge: "refunded",
      statusLabel: "Estornado",
      methodLabel,
      moneyEntered: false,
      isRevenue: false,
      displayAmount: settlementDisplayAmount(payment),
      amountCaption: "valor estornado",
      whenIso: payment.paid_at ?? null,
    };
  }

  if (nature === "courtesy") {
    return {
      badge: "courtesy",
      statusLabel: "Cortesia",
      methodLabel,
      moneyEntered: false,
      isRevenue: false,
      displayAmount: null,
      amountCaption: "não é receita",
      whenIso: payment.paid_at ?? null,
    };
  }

  if (nature === "coupon_zero") {
    return {
      badge: "coupon_zero",
      statusLabel: "Cupom 100%",
      methodLabel,
      moneyEntered: false,
      isRevenue: false,
      displayAmount: null,
      amountCaption: "não é receita",
      whenIso: payment.paid_at ?? null,
    };
  }

  if (nature === "off_gateway") {
    return {
      badge: "off_gateway",
      statusLabel: "Fora do gateway",
      methodLabel,
      moneyEntered: true,
      isRevenue,
      displayAmount: settlementDisplayAmount(payment),
      amountCaption: "valor recebido",
      whenIso: payment.off_gateway_received_at ?? payment.paid_at ?? null,
    };
  }

  if (status === "paid") {
    return {
      badge: "paid",
      statusLabel: "Pago",
      methodLabel,
      moneyEntered: isRevenue,
      isRevenue,
      displayAmount: isRevenue ? confirmedRevenueAmount(payment) : settlementDisplayAmount(payment),
      amountCaption: isRevenue ? "valor recebido" : "fora da receita operacional",
      whenIso: payment.paid_at ?? null,
    };
  }

  if (status === "expired") {
    return {
      badge: "expired",
      statusLabel: "Expirado",
      methodLabel,
      moneyEntered: false,
      isRevenue: false,
      displayAmount: settlementDisplayAmount(payment),
      amountCaption: "cobrança não liquidada",
      whenIso: null,
    };
  }

  if (status === "cancelled") {
    return {
      badge: "cancelled",
      statusLabel: "Cancelado",
      methodLabel,
      moneyEntered: false,
      isRevenue: false,
      displayAmount: settlementDisplayAmount(payment),
      amountCaption: "cobrança não liquidada",
      whenIso: null,
    };
  }

  return {
    badge: "pending",
    statusLabel: "Pendente",
    methodLabel,
    moneyEntered: false,
    isRevenue: false,
    displayAmount: settlementDisplayAmount(payment),
    amountCaption: "aguardando liquidação",
    whenIso: null,
  };
}

export function offGatewayExpectedAmount(payment: SettlementSource, orderFinalAmount?: number | null) {
  const orderNet = Number(orderFinalAmount);
  if (Number.isFinite(orderNet) && orderNet > 0) return orderNet;
  const paymentNet = Number(payment.amount ?? 0) - Number(payment.discount_amount ?? 0);
  if (paymentNet > 0) return paymentNet;
  const catalog = Number(payment.amount ?? 0);
  if (catalog > 0) return catalog;
  const finalAmount = Number(payment.final_amount ?? 0);
  return Number.isFinite(finalAmount) ? finalAmount : 0;
}

export function canShowOffGatewayRegularizeCta(input: {
  payment?: SettlementSource | null;
  hasPermission: boolean;
  surface: "order" | "payment";
}) {
  if (!input.hasPermission) {
    return { show: false, replace: false, reason: null as string | null };
  }
  if (!input.payment) {
    return {
      show: false,
      replace: false,
      reason: "Este pedido não tem um pagamento que possa ser regularizado fora do gateway.",
    };
  }

  const eligibility = canRegisterOffGatewayPayment(input.payment);
  if (!eligibility.allowed) {
    return { show: false, replace: false, reason: eligibility.reason };
  }

  if (input.surface === "order" && eligibility.replace) {
    return {
      show: false,
      replace: true,
      reason: "Pagamento fora do gateway já registrado. Abra o pagamento para substituir, se necessário.",
    };
  }

  if (input.surface === "order" && resolveSettlementNature(input.payment) === "courtesy") {
    return { show: false, replace: false, reason: null };
  }

  return { show: true, replace: eligibility.replace, reason: null as string | null };
}
