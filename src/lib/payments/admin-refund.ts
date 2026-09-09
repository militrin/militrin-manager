import {
  evaluateAdminRefundEligibility,
  validateAdminRefundReason,
  type AdminRefundEligibilityPayment,
  type AdminRefundReasonCode,
} from "./admin-refund-eligibility.ts";
import { isGatewayTimeoutError } from "./gateway-timeout.ts";
import type { GatewayPaymentSnapshot, GetPaymentInput, RefundPaymentInput } from "./provider.ts";

export type AdminRefundPaymentRecord = AdminRefundEligibilityPayment & {
  id: string;
  organization_id: string;
  order_id?: string | null;
  event_id?: string | null;
};

export type BeginAdminRefundResult = {
  success: boolean;
  already_completed?: boolean;
  already_open?: boolean;
  attempt_id?: string;
  payment_id?: string;
  refund_status?: string;
  attempt_status?: string;
  cancel_tickets?: boolean;
  gateway_payment_id?: string;
  account_key?: string;
  organization_id?: string;
  amount?: number;
};

export type AdminRefundGateway = {
  refundPayment: (input: RefundPaymentInput) => Promise<void>;
  getPayment: (input: GetPaymentInput) => Promise<GatewayPaymentSnapshot>;
};

export type AdminRefundDeps = {
  assertAuthorized: () => Promise<void>;
  accountKeyConfigured: (accountKey: string) => boolean;
  loadPayment: (paymentId: string) => Promise<AdminRefundPaymentRecord | null>;
  beginAttempt: (input: {
    paymentId: string;
    reasonCode: AdminRefundReasonCode;
    reasonText?: string | null;
    cancelTickets: boolean;
  }) => Promise<BeginAdminRefundResult>;
  markAttempt: (
    attemptId: string,
    status: "pending" | "failed" | "uncertain",
    failureText?: string | null,
    gatewayResponse?: Record<string, unknown>,
  ) => Promise<void>;
  applyGatewayStatus: (input: {
    provider: string;
    providerPaymentId: string;
    providerStatus: string;
    internalStatus: string;
    expectedAccountKey: string;
    eventType?: string | null;
  }) => Promise<void>;
  notifyFailure: (paymentId: string) => Promise<void>;
  getGateway: (accountKey: string) => AdminRefundGateway;
};

export type ExecuteAdminPaymentRefundInput = {
  paymentId: string;
  reasonCode: string;
  reasonText?: string | null;
  cancelTickets: boolean;
  confirmPhrase: string;
  mode?: "execute" | "reconcile";
};

export type ExecuteAdminPaymentRefundResult = {
  ok: boolean;
  status: "completed" | "pending" | "uncertain" | "failed" | "forbidden" | "blocked";
  message: string;
  attemptId?: string;
  gatewayCalled: boolean;
  externalHttp: false;
};

function sanitizeGatewaySnapshot(snapshot: GatewayPaymentSnapshot | null | undefined) {
  if (!snapshot) return {};
  return {
    providerPaymentId: snapshot.providerPaymentId,
    status: snapshot.status,
    providerStatus: snapshot.providerStatus,
    paidAt: snapshot.paidAt,
    feeAmount: snapshot.feeAmount,
    netAmount: snapshot.netAmount,
  };
}

async function reconcileFromSnapshot(args: {
  deps: AdminRefundDeps;
  payment: AdminRefundPaymentRecord;
  attemptId: string;
  snapshot: GatewayPaymentSnapshot;
}) {
  const accountKey = String(args.payment.gateway_account_key ?? "").trim();
  if (args.snapshot.status === "refunded") {
    await args.deps.applyGatewayStatus({
      provider: "asaas",
      providerPaymentId: args.snapshot.providerPaymentId,
      providerStatus: args.snapshot.providerStatus,
      internalStatus: "refunded",
      expectedAccountKey: accountKey,
      eventType: "PAYMENT_REFUNDED",
    });
    return { ok: true, status: "completed" as const, message: "Estorno confirmado pelo gateway." };
  }
  if (args.snapshot.status === "processing") {
    await args.deps.markAttempt(args.attemptId, "pending", null, sanitizeGatewaySnapshot(args.snapshot));
    return {
      ok: true,
      status: "pending" as const,
      message: "Estorno em processamento no gateway. Aguarde o webhook ou concilie depois.",
    };
  }
  return null;
}

export async function executeAdminPaymentRefund(
  input: ExecuteAdminPaymentRefundInput,
  deps: AdminRefundDeps,
): Promise<ExecuteAdminPaymentRefundResult> {
  const deny = (status: ExecuteAdminPaymentRefundResult["status"], message: string): ExecuteAdminPaymentRefundResult => ({
    ok: false,
    status,
    message,
    gatewayCalled: false,
    externalHttp: false,
  });

  try {
    await deps.assertAuthorized();
  } catch (error) {
    if (error instanceof Error && error.name === "PermissionDeniedError") {
      return deny("forbidden", "Sem permissão para estornar pagamento.");
    }
    throw error;
  }

  const payment = await deps.loadPayment(input.paymentId);
  if (!payment?.id) return deny("blocked", "Pagamento não encontrado.");

  const accountKey = String(payment.gateway_account_key ?? "").trim();
  const eligibility = evaluateAdminRefundEligibility(payment, {
    accountKeyConfigured: deps.accountKeyConfigured(accountKey),
  });

  const reasonError = validateAdminRefundReason(input.reasonCode, input.reasonText);
  if (reasonError) return deny("blocked", reasonError);

  const confirmExpected = eligibility.needsConfirmPhrase;
  const confirmGiven = String(input.confirmPhrase ?? "").trim();
  if (eligibility.eligible && confirmExpected && confirmGiven !== confirmExpected) {
    return deny("blocked", `Digite exatamente: ${confirmExpected}`);
  }

  const inFlight = !eligibility.eligible && eligibility.blockCode === "refund_in_flight";
  const canStart = eligibility.eligible || inFlight || input.mode === "reconcile";
  if (!canStart) {
    return deny("blocked", eligibility.reason ?? "Este pagamento não pode ser estornado.");
  }

  const begun = await deps.beginAttempt({
    paymentId: payment.id,
    reasonCode: input.reasonCode as AdminRefundReasonCode,
    reasonText: input.reasonText,
    cancelTickets: input.cancelTickets,
  });

  if (begun.already_completed) {
    return {
      ok: true,
      status: "completed",
      message: "Este pagamento já foi estornado.",
      attemptId: begun.attempt_id,
      gatewayCalled: false,
      externalHttp: false,
    };
  }

  const attemptId = String(begun.attempt_id ?? "");
  if (!attemptId) return deny("failed", "Não foi possível registrar a tentativa de estorno.");

  const gatewayId = String(begun.gateway_payment_id ?? payment.gateway_payment_id ?? "").trim();
  const gatewayAccount = String(begun.account_key ?? accountKey).trim();
  const organizationId = String(begun.organization_id ?? payment.organization_id);
  const gateway = deps.getGateway(gatewayAccount);
  let gatewayCalled = false;

  const fail = async (message: string, notify: boolean): Promise<ExecuteAdminPaymentRefundResult> => {
    await deps.markAttempt(attemptId, "failed", message);
    if (notify) await deps.notifyFailure(payment.id);
    return { ok: false, status: "failed", message, attemptId, gatewayCalled, externalHttp: false };
  };

  const uncertain = async (message: string): Promise<ExecuteAdminPaymentRefundResult> => {
    await deps.markAttempt(attemptId, "uncertain", message);
    return {
      ok: true,
      status: "uncertain",
      message,
      attemptId,
      gatewayCalled,
      externalHttp: false,
    };
  };

  try {
    const shouldInspectFirst = Boolean(begun.already_open) || input.mode === "reconcile"
      || String(begun.attempt_status ?? "") === "uncertain"
      || String(begun.attempt_status ?? "") === "pending";

    if (shouldInspectFirst) {
      let snapshot: GatewayPaymentSnapshot;
      try {
        snapshot = await gateway.getPayment({ organizationId, providerPaymentId: gatewayId });
        gatewayCalled = true;
      } catch (error) {
        if (isGatewayTimeoutError(error)) {
          return uncertain("Timeout ao consultar o gateway. O estorno não foi assumido como falha; concilie antes de tentar de novo.");
        }
        throw error;
      }
      const reconciled = await reconcileFromSnapshot({ deps, payment, attemptId, snapshot });
      if (reconciled) {
        return { ...reconciled, attemptId, gatewayCalled, externalHttp: false };
      }
      const attemptStatus = String(begun.attempt_status ?? "");
      if (attemptStatus === "pending") {
        await deps.markAttempt(attemptId, "pending", null, sanitizeGatewaySnapshot(snapshot));
        return {
          ok: true,
          status: "pending",
          message: "Estorno ainda em processamento no gateway. Nenhuma nova chamada de refund foi feita.",
          attemptId,
          gatewayCalled,
          externalHttp: false,
        };
      }
    }

    await deps.markAttempt(attemptId, "pending", null, { phase: "calling_refund" });

    try {
      await gateway.refundPayment({
        organizationId,
        providerPaymentId: gatewayId,
        reason: input.reasonText || input.reasonCode,
      });
      gatewayCalled = true;
    } catch (error) {
      if (isGatewayTimeoutError(error)) {
        return uncertain("Timeout ao solicitar o estorno no Asaas. O estado ficou em conciliação; consulte o gateway antes de tentar de novo.");
      }
      throw error;
    }

    let snapshot: GatewayPaymentSnapshot;
    try {
      snapshot = await gateway.getPayment({ organizationId, providerPaymentId: gatewayId });
    } catch (error) {
      if (isGatewayTimeoutError(error)) {
        return uncertain("O Asaas pode ter recebido o estorno, mas a consulta atrasou. Concilie pelo identificador da cobrança antes de tentar de novo.");
      }
      throw error;
    }

    const reconciled = await reconcileFromSnapshot({ deps, payment, attemptId, snapshot });
    if (reconciled) {
      return { ...reconciled, attemptId, gatewayCalled, externalHttp: false };
    }

    await deps.markAttempt(attemptId, "pending", null, sanitizeGatewaySnapshot(snapshot));
    return {
      ok: true,
      status: "pending",
      message: "Estorno solicitado ao gateway. Aguardando confirmação.",
      attemptId,
      gatewayCalled,
      externalHttp: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message || "Falha ao estornar pagamento.", true);
  }
}
