import { isLegacyUnknownPriceOrigin, shouldIncludeAmountInFinancialTotals } from "../imports/legacy-price.ts";
import { isSyntheticGatewayPayment } from "../finance/confirmed-revenue.ts";
import { resolveGatewayEnvironment } from "./gateway-environment.ts";

export const ADMIN_REFUND_REASON_CODES = [
  "customer_request",
  "duplicate_purchase",
  "operational_error",
  "event_category_changed",
  "administrative_test",
  "other",
] as const;

export type AdminRefundReasonCode = (typeof ADMIN_REFUND_REASON_CODES)[number];

export const ADMIN_REFUND_REASON_LABELS: Record<AdminRefundReasonCode, string> = {
  customer_request: "Solicitação do cliente",
  duplicate_purchase: "Compra duplicada",
  operational_error: "Erro operacional",
  event_category_changed: "Evento/categoria alterado",
  administrative_test: "Teste administrativo",
  other: "Outro",
};

export const ADMIN_REFUND_STATUSES = [
  "requested",
  "pending",
  "completed",
  "failed",
  "uncertain",
] as const;

export type AdminRefundStatus = (typeof ADMIN_REFUND_STATUSES)[number];

export type AdminRefundEligibilityPayment = {
  id?: string | null;
  provider?: string | null;
  payment_status?: string | null;
  payment_method?: string | null;
  price_origin?: string | null;
  gateway_payment_id?: string | null;
  gateway_account_key?: string | null;
  gateway_environment?: string | null;
  final_amount?: number | null;
  amount?: number | null;
  refund_status?: string | null;
};

export type AdminRefundBlockCode =
  | "not_asaas"
  | "missing_gateway_id"
  | "unknown_account_key"
  | "unknown_environment"
  | "amount_not_positive"
  | "not_paid"
  | "already_refunded"
  | "refund_in_flight"
  | "fake"
  | "legacy_unknown"
  | "courtesy"
  | "cancelled"
  | "expired"
  | "pending";

export const ADMIN_REFUND_BLOCK_MESSAGES: Record<AdminRefundBlockCode, string> = {
  not_asaas: "Estorno administrativo só está disponível para pagamentos Asaas.",
  missing_gateway_id: "Este pagamento não tem identificador de cobrança no gateway.",
  unknown_account_key: "A conta Asaas original desta cobrança não está configurada.",
  unknown_environment: "O ambiente da cobrança (LIVE/SANDBOX) não está identificado.",
  amount_not_positive: "Só é possível estornar um valor maior que zero.",
  not_paid: "Só é possível estornar um pagamento confirmado.",
  already_refunded: "Este pagamento já foi estornado.",
  refund_in_flight: "Já existe um estorno em andamento. Concilie antes de tentar de novo.",
  fake: "Pagamento sintético/fake não pode ser estornado no Asaas.",
  legacy_unknown: "Pagamento com preço histórico não informado não entra no estorno Asaas.",
  courtesy: "Cortesia não é cobrança de gateway e não pode ser estornada no Asaas.",
  cancelled: "Pagamento cancelado não pode ser estornado.",
  expired: "Pagamento expirado não pode ser estornado.",
  pending: "Pagamento pendente ainda não foi confirmado.",
};

export type AdminRefundEligibility = {
  eligible: boolean;
  blockCode: AdminRefundBlockCode | null;
  reason: string | null;
  canReconcile: boolean;
  needsConfirmPhrase: string | null;
};

function amountOf(payment: AdminRefundEligibilityPayment) {
  const value = Number(payment.final_amount ?? payment.amount ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export function isAdminRefundReasonCode(value: string | null | undefined): value is AdminRefundReasonCode {
  return ADMIN_REFUND_REASON_CODES.includes(String(value ?? "") as AdminRefundReasonCode);
}

export function validateAdminRefundReason(reasonCode: string, reasonText?: string | null) {
  if (!isAdminRefundReasonCode(reasonCode)) {
    return "Selecione um motivo para o estorno.";
  }
  if (reasonCode === "other" && !String(reasonText ?? "").trim()) {
    return "Descreva o motivo do estorno.";
  }
  return null;
}

export function adminRefundVisualStatus(payment: Pick<AdminRefundEligibilityPayment, "payment_status" | "refund_status">) {
  const refund = String(payment.refund_status ?? "").trim().toLowerCase();
  const status = String(payment.payment_status ?? "").trim().toLowerCase();
  if (status === "refunded" || refund === "completed") return "refunded" as const;
  if (refund === "failed") return "failed" as const;
  if (refund === "uncertain") return "uncertain" as const;
  if (refund === "pending") return "refund_pending" as const;
  if (refund === "requested") return "requested" as const;
  return status || "unknown";
}

export function adminRefundVisualLabel(status: string) {
  if (status === "refunded") return "Estornado";
  if (status === "failed") return "Falha no estorno";
  if (status === "uncertain") return "Estorno em conciliação";
  if (status === "refund_pending") return "Estorno em processamento";
  if (status === "requested") return "Estorno solicitado";
  if (status === "paid") return "Confirmado";
  if (status === "pending_payment" || status === "pending") return "Pendente";
  return status;
}

export function evaluateAdminRefundEligibility(
  payment: AdminRefundEligibilityPayment,
  options?: { accountKeyConfigured?: boolean },
): AdminRefundEligibility {
  const provider = String(payment.provider ?? "").trim().toLowerCase();
  const status = String(payment.payment_status ?? "").trim().toLowerCase();
  const method = String(payment.payment_method ?? "").trim().toLowerCase();
  const refundStatus = String(payment.refund_status ?? "").trim().toLowerCase();
  const gatewayId = String(payment.gateway_payment_id ?? "").trim();
  const accountKey = String(payment.gateway_account_key ?? "").trim();
  const environment = resolveGatewayEnvironment(payment);
  const amount = amountOf(payment);
  const accountConfigured = options?.accountKeyConfigured ?? Boolean(accountKey);

  const blocked = (blockCode: AdminRefundBlockCode, canReconcile = false): AdminRefundEligibility => ({
    eligible: false,
    blockCode,
    reason: ADMIN_REFUND_BLOCK_MESSAGES[blockCode],
    canReconcile,
    needsConfirmPhrase: null,
  });

  if (method === "courtesy" || status === "courtesy") return blocked("courtesy");
  if (isLegacyUnknownPriceOrigin(payment.price_origin) || !shouldIncludeAmountInFinancialTotals(payment.price_origin)) {
    return blocked("legacy_unknown");
  }
  if (isSyntheticGatewayPayment(payment) || provider === "fake") return blocked("fake");
  if (provider !== "asaas") return blocked("not_asaas");
  if (!gatewayId) return blocked("missing_gateway_id");
  if (!accountKey) return blocked("unknown_account_key");
  if (!accountConfigured) return blocked("unknown_account_key");
  if (!environment) return blocked("unknown_environment");
  if (!(amount > 0)) return blocked("amount_not_positive");
  if (status === "refunded" || refundStatus === "completed") return blocked("already_refunded");
  if (status === "cancelled" || status === "canceled") return blocked("cancelled");
  if (status === "expired") return blocked("expired");
  if (status === "pending") return blocked("pending");
  if (status !== "paid") return blocked("not_paid");
  if (refundStatus === "requested" || refundStatus === "pending" || refundStatus === "uncertain") {
    return blocked("refund_in_flight", refundStatus === "uncertain" || refundStatus === "pending");
  }

  const formatted = amount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  return {
    eligible: true,
    blockCode: null,
    reason: null,
    canReconcile: false,
    needsConfirmPhrase: `Confirmo o estorno de ${formatted}`,
  };
}
