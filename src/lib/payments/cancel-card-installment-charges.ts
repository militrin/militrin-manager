import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isAsaasPaymentAlreadyDeletedError,
  isAsaasPaymentNotDeletableError,
  isAsaasRetryableError,
} from "./asaas-api-error.ts";
import type { GatewayPaymentSnapshot, PaymentGatewayProvider } from "./provider.ts";

const PAID_PROVIDER_STATUSES = new Set([
  "RECEIVED",
  "CONFIRMED",
  "RECEIVED_IN_CASH",
  "DUNNING_RECEIVED",
]);

export type CardChargeInspection = {
  providerPaymentId: string;
  gone: boolean;
  paid: boolean;
  providerStatus: string | null;
  internalStatus: string | null;
  alreadyDeleted: boolean;
  amount: number | null;
};

export type CancelCardInstallmentResult = {
  ok: boolean;
  stop: boolean;
  terminalize: boolean;
  reason: string;
  listedIds: string[];
  inspectionsBefore: CardChargeInspection[];
  cancellations: Array<{ providerPaymentId: string; outcome: string; error?: string }>;
  inspectionsAfter: CardChargeInspection[];
};

export type CancelCardInstallmentInput = {
  supabase: SupabaseClient;
  paymentId: string;
  organizationId: string;
  reason: string;
  /** Allowlist do encerramento pontual 2295. Omitir no worker generico. */
  expectedChargeIds?: string[];
  expectedInstallmentId?: string | null;
  getGateway?: () => PaymentGatewayProvider;
  auditSource?: string;
};

function paidLike(snapshot: GatewayPaymentSnapshot): boolean {
  if (snapshot.status === "paid") return true;
  return PAID_PROVIDER_STATUSES.has(String(snapshot.providerStatus ?? "").toUpperCase());
}

function goneLike(snapshot: GatewayPaymentSnapshot): boolean {
  const providerStatus = String(snapshot.providerStatus ?? "").toUpperCase();
  return snapshot.status === "expired"
    || snapshot.status === "cancelled"
    || providerStatus === "DELETED"
    || providerStatus === "REMOVED";
}

async function inspectCharge(
  gateway: PaymentGatewayProvider,
  organizationId: string,
  providerPaymentId: string,
): Promise<CardChargeInspection> {
  try {
    const snapshot = await gateway.getPayment({ organizationId, providerPaymentId });
    return {
      providerPaymentId,
      gone: goneLike(snapshot),
      paid: paidLike(snapshot),
      providerStatus: snapshot.providerStatus ?? null,
      internalStatus: snapshot.status ?? null,
      alreadyDeleted: false,
      amount: snapshot.amount ?? null,
    };
  } catch (error) {
    if (isAsaasPaymentAlreadyDeletedError(error)) {
      return {
        providerPaymentId,
        gone: true,
        paid: false,
        providerStatus: "DELETED",
        internalStatus: "cancelled",
        alreadyDeleted: true,
        amount: null,
      };
    }
    throw error;
  }
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean))];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fluxo de cartao/parcelamento: list_live_gateway_charge_ids + GET + cancelPayment
 * + GET de confirmacao. Nao terminaliza payment/order.
 * Estoque permanece reserved ate o chamador aplicar complete_expired_* / _apply_terminal.
 * Nao assume que cancelar a primeira charge cancele o parcelamento: inspeciona e
 * cancela TODAS as charges vivas, inclusive gateway_installment_id.
 */
export async function cancelCardInstallmentCharges(
  input: CancelCardInstallmentInput,
): Promise<CancelCardInstallmentResult> {
  const expected = uniqueIds(input.expectedChargeIds ?? []);
  const expectedInstallmentId = String(input.expectedInstallmentId ?? "").trim();
  const empty: CancelCardInstallmentResult = {
    ok: false,
    stop: true,
    terminalize: false,
    reason: "init",
    listedIds: [],
    inspectionsBefore: [],
    cancellations: [],
    inspectionsAfter: [],
  };

  const { data: chargeIds, error: listError } = await input.supabase.rpc("list_live_gateway_charge_ids", {
    p_payment_id: input.paymentId,
  });
  if (listError) {
    return { ...empty, reason: `list_live_gateway_charge_ids: ${listError.message}` };
  }

  const listed = uniqueIds(Array.isArray(chargeIds) ? chargeIds.map((id) => String(id)) : []);
  const { data: chargeRows, error: chargeError } = await input.supabase
    .from("payment_gateway_charges")
    .select("gateway_payment_id, gateway_installment_id, deleted")
    .eq("payment_id", input.paymentId);

  if (chargeError) {
    return { ...empty, listedIds: listed, reason: `payment_gateway_charges: ${chargeError.message}` };
  }

  const rows = Array.isArray(chargeRows) ? chargeRows : [];
  const installmentIds = uniqueIds(rows.map((row) => String(row.gateway_installment_id ?? "")));
  if (expectedInstallmentId) {
    if (installmentIds.length > 1 || (installmentIds.length === 1 && installmentIds[0] !== expectedInstallmentId)) {
      return {
        ...empty,
        listedIds: listed,
        reason: `installment_mismatch:${installmentIds.join(",") || "none"}`,
      };
    }
  } else if (installmentIds.length > 1) {
    return {
      ...empty,
      listedIds: listed,
      reason: `installment_mismatch:${installmentIds.join(",")}`,
    };
  }

  const dbIds = uniqueIds(rows.map((row) => String(row.gateway_payment_id ?? "")));
  if (expected.length > 0) {
    const expectedSet = new Set(expected);
    const dbSet = new Set(dbIds);
    if (expected.length !== dbSet.size || expected.some((id) => !dbSet.has(id)) || dbIds.some((id) => !expectedSet.has(id))) {
      return {
        ...empty,
        listedIds: listed,
        reason: `charge_ids_mismatch:${dbIds.join(",")}`,
      };
    }
  }

  const targets = uniqueIds([...expected, ...dbIds, ...listed]);
  if (targets.length === 0) {
    return { ...empty, listedIds: listed, reason: "no_live_charges" };
  }
  let gateway: PaymentGatewayProvider;
  try {
    gateway = input.getGateway?.()
      ?? (await import("./get-gateway-provider.ts")).getPaymentGatewayProviderForMethod("credit_card");
  } catch (error) {
    return { ...empty, listedIds: listed, reason: errorMessage(error) };
  }

  let inspectionsBefore: CardChargeInspection[];
  try {
    inspectionsBefore = [];
    for (const providerPaymentId of targets) {
      inspectionsBefore.push(await inspectCharge(gateway, input.organizationId, providerPaymentId));
    }
  } catch (error) {
    return {
      ...empty,
      listedIds: listed,
      reason: isAsaasRetryableError(error) ? `retryable:${errorMessage(error)}` : errorMessage(error),
    };
  }

  if (inspectionsBefore.some((row) => row.paid)) {
    return {
      ...empty,
      listedIds: listed,
      inspectionsBefore,
      reason: "paid_equivalent",
    };
  }

  const pendingOrLive = inspectionsBefore.filter(
    (row) => !row.gone && !row.paid,
  );
  const cancellations: CancelCardInstallmentResult["cancellations"] = [];

  for (const row of pendingOrLive) {
    try {
      await gateway.cancelPayment({
        organizationId: input.organizationId,
        providerPaymentId: row.providerPaymentId,
        reason: input.reason,
      });
      cancellations.push({ providerPaymentId: row.providerPaymentId, outcome: "cancelled" });
    } catch (error) {
      if (isAsaasPaymentAlreadyDeletedError(error)) {
        cancellations.push({ providerPaymentId: row.providerPaymentId, outcome: "already_deleted" });
        continue;
      }
      if (isAsaasPaymentNotDeletableError(error)) {
        return {
          ok: false,
          stop: true,
          terminalize: false,
          reason: `not_deletable:${errorMessage(error)}`,
          listedIds: listed,
          inspectionsBefore,
          cancellations,
          inspectionsAfter: [],
        };
      }
      return {
        ok: false,
        stop: true,
        terminalize: false,
        reason: isAsaasRetryableError(error)
          ? `retryable:${errorMessage(error)}`
          : errorMessage(error),
        listedIds: listed,
        inspectionsBefore,
        cancellations,
        inspectionsAfter: [],
      };
    }
  }

  let inspectionsAfter: CardChargeInspection[];
  try {
    inspectionsAfter = [];
    for (const providerPaymentId of targets) {
      inspectionsAfter.push(await inspectCharge(gateway, input.organizationId, providerPaymentId));
    }
  } catch (error) {
    return {
      ok: false,
      stop: true,
      terminalize: false,
      reason: isAsaasRetryableError(error) ? `retryable_confirm:${errorMessage(error)}` : `confirm:${errorMessage(error)}`,
      listedIds: listed,
      inspectionsBefore,
      cancellations,
      inspectionsAfter: [],
    };
  }

  if (inspectionsAfter.some((row) => row.paid)) {
    return {
      ok: false,
      stop: true,
      terminalize: false,
      reason: "paid_equivalent_after_cancel",
      listedIds: listed,
      inspectionsBefore,
      cancellations,
      inspectionsAfter,
    };
  }

  if (inspectionsAfter.some((row) => !row.gone)) {
    return {
      ok: false,
      stop: true,
      terminalize: false,
      reason: "inconsistent_still_payable",
      listedIds: listed,
      inspectionsBefore,
      cancellations,
      inspectionsAfter,
    };
  }

  const { error: markError } = await input.supabase.rpc("mark_gateway_charges_not_reusable", {
    p_payment_id: input.paymentId,
  });
  if (markError) {
    return {
      ok: false,
      stop: true,
      terminalize: false,
      reason: `mark_gateway_charges_not_reusable:${markError.message}`,
      listedIds: listed,
      inspectionsBefore,
      cancellations,
      inspectionsAfter,
    };
  }

  await input.supabase.from("audit_logs").insert(
    inspectionsAfter.map((row) => ({
      action: "payment_gateway_charge_deleted",
      entity_type: "payments",
      entity_id: input.paymentId,
      details: {
        provider: "asaas",
        provider_payment_id: row.providerPaymentId,
        source: input.auditSource ?? "cancel-stale-card-charges",
        already_deleted: row.alreadyDeleted,
      },
    })),
  );

  return {
    ok: true,
    stop: false,
    terminalize: true,
    reason: "gateway_cancelled",
    listedIds: listed,
    inspectionsBefore,
    cancellations,
    inspectionsAfter,
  };
}
