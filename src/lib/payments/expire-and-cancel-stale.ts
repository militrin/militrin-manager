import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isAsaasPaymentAlreadyDeletedError,
  isAsaasPaymentNotDeletableError,
  isAsaasRetryableError,
} from "./asaas-api-error.ts";
import { cancelCardInstallmentCharges } from "./cancel-card-installment-charges.ts";
import type { GatewayPaymentSnapshot, PaymentGatewayProvider } from "./provider.ts";

type ClaimedPixCancellation = {
  payment_id: string;
  organization_id: string;
  provider: string | null;
  provider_payment_id: string | null;
  gateway_account_key: string | null;
  order_id: string | null;
};

type ClaimedPaymentMeta = {
  payment_method: string;
  gateway_installment_id: string | null;
};

export type ExpireAndCancelStaleResult = {
  claimed: number;
  expired: number;
  paid: number;
  failed: number;
  skipped: number;
};

export type ExpireAndCancelStaleDeps = {
  supabase?: SupabaseClient;
  limit?: number;
  organizationId?: string | null;
  getGateway?: (accountKey: string | null) => PaymentGatewayProvider | null;
};

function asClaimed(row: unknown): ClaimedPixCancellation | null {
  if (!row || typeof row !== "object") return null;
  const value = row as Record<string, unknown>;
  if (!value.payment_id) return null;
  return {
    payment_id: String(value.payment_id),
    organization_id: String(value.organization_id ?? ""),
    provider: value.provider == null ? null : String(value.provider),
    provider_payment_id: value.provider_payment_id == null ? null : String(value.provider_payment_id),
    gateway_account_key: value.gateway_account_key == null ? null : String(value.gateway_account_key),
    order_id: value.order_id == null ? null : String(value.order_id),
  };
}

async function failCancellation(supabase: SupabaseClient, paymentId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const { error: failError } = await supabase.rpc("fail_expired_pix_cancellation", {
    p_payment_id: paymentId,
    p_error: message.slice(0, 1000),
  });
  if (failError) {
    console.error("[expire-payments] fail_expired_pix_cancellation_failed", {
      paymentId,
      error: failError.message,
    });
  }
}

async function completeCancellation(supabase: SupabaseClient, paymentId: string) {
  const { data, error } = await supabase.rpc("complete_expired_pix_cancellation", {
    p_payment_id: paymentId,
  });
  if (error) throw error;
  return String(data ?? "");
}

async function confirmPaidAndClearLease(supabase: SupabaseClient, paymentId: string) {
  const outcome = await completeCancellation(supabase, paymentId);
  if (outcome !== "already_paid" && outcome !== "already_terminal") {
    throw new Error(`complete_expired apos pago retornou ${outcome || "empty"}`);
  }
  return outcome;
}

async function applyReceivedPayment(
  supabase: SupabaseClient,
  claimed: ClaimedPixCancellation,
  snapshot: GatewayPaymentSnapshot,
) {
  const { data, error } = await supabase.rpc("apply_gateway_payment_status", {
    p_provider: claimed.provider ?? "asaas",
    p_provider_payment_id: claimed.provider_payment_id,
    p_provider_status: snapshot.providerStatus,
    p_internal_status: "paid",
    p_expected_gateway_account_key: claimed.gateway_account_key,
    p_gateway_amount: snapshot.amount ?? null,
  });
  if (error) throw error;
  const applied = Array.isArray(data) ? data[0] : data;
  const appliedStatus = String((applied as { applied_status?: string } | null)?.applied_status ?? "");
  if (appliedStatus !== "paid") {
    throw new Error(
      `apply_gateway_payment_status nao confirmou pago (applied=${appliedStatus || "empty"}; amount=${snapshot.amount ?? "null"})`,
    );
  }
}

function isPaidSnapshot(snapshot: GatewayPaymentSnapshot) {
  return snapshot.status === "paid";
}

function isGoneOrCancelledSnapshot(snapshot: GatewayPaymentSnapshot) {
  const providerStatus = String(snapshot.providerStatus ?? "").toUpperCase();
  return snapshot.status === "expired"
    || snapshot.status === "cancelled"
    || providerStatus === "DELETED"
    || providerStatus === "REMOVED";
}

/**
 * 1) expire_stale carimba pending_cancel (sem liberar estoque).
 * 2) Este worker GET + DELETE Asaas (PIX: cobranca unica; cartao: todas as charges).
 * 3) So depois de cancelamento confirmado (ou ja removido) chama complete → _apply_terminal.
 * Timeout/5xx: fail, estoque permanece reserved, retry idempotente.
 * RECEIVED/CONFIRMED: nao terminaliza; encaminha ao fluxo pago.
 */
export async function expireAndCancelStalePixPayments(
  deps: ExpireAndCancelStaleDeps = {},
): Promise<ExpireAndCancelStaleResult> {
  return expireAndCancelStaleCheckoutPayments(deps);
}

export async function expireAndCancelStaleCheckoutPayments(
  deps: ExpireAndCancelStaleDeps = {},
): Promise<ExpireAndCancelStaleResult> {
  const supabase = deps.supabase ?? (await import("../supabase/admin.ts")).createServiceRoleSupabaseClient();
  const getGateway = deps.getGateway
    ?? (await import("./get-gateway-provider.ts")).tryGetPaymentGatewayProviderForAccountKey;
  const result: ExpireAndCancelStaleResult = {
    claimed: 0,
    expired: 0,
    paid: 0,
    failed: 0,
    skipped: 0,
  };

  const { error: stampError } = await supabase.rpc("expire_stale_order_payments", {
    p_organization_id: deps.organizationId ?? null,
  });
  if (stampError) {
    throw new Error(`expire_stale_order_payments: ${stampError.message}`);
  }

  const { data: claimedRows, error: claimError } = await supabase.rpc("claim_expired_pix_cancellations", {
    p_limit: deps.limit ?? 20,
    p_organization_id: deps.organizationId ?? null,
  });
  if (claimError) {
    throw new Error(`claim_expired_pix_cancellations: ${claimError.message}`);
  }

  const claimed = (Array.isArray(claimedRows) ? claimedRows : claimedRows ? [claimedRows] : [])
    .map(asClaimed)
    .filter((row): row is ClaimedPixCancellation => Boolean(row));
  result.claimed = claimed.length;

  for (const row of claimed) {
    if (!row.provider_payment_id) {
      await failCancellation(supabase, row.payment_id, "provider_payment_id ausente");
      result.failed += 1;
      continue;
    }

    const gateway = getGateway(row.gateway_account_key);
    if (!gateway) {
      await failCancellation(supabase, row.payment_id, "gateway_account_key ausente ou nao configurada");
      result.failed += 1;
      continue;
    }

    const { data: metaRow, error: metaError } = await supabase
      .from("payments")
      .select("payment_method, gateway_installment_id")
      .eq("id", row.payment_id)
      .maybeSingle();
    if (metaError) {
      await failCancellation(supabase, row.payment_id, metaError);
      result.failed += 1;
      continue;
    }
    const meta: ClaimedPaymentMeta = {
      payment_method: String(metaRow?.payment_method ?? "pix").toLowerCase(),
      gateway_installment_id: metaRow?.gateway_installment_id ? String(metaRow.gateway_installment_id) : null,
    };

    if (meta.payment_method === "credit_card") {
      try {
        const cardResult = await cancelCardInstallmentCharges({
          supabase,
          paymentId: row.payment_id,
          organizationId: row.organization_id,
          reason: "Hold de checkout de 10 minutos expirado.",
          expectedInstallmentId: meta.gateway_installment_id,
          getGateway: () => gateway,
          auditSource: "expire-checkout-hold",
        });

        if (cardResult.reason === "paid_equivalent" || cardResult.reason === "paid_equivalent_after_cancel") {
          const paid = [...cardResult.inspectionsBefore, ...cardResult.inspectionsAfter]
            .find((item) => item.paid);
          const paidId = paid?.providerPaymentId ?? row.provider_payment_id;
          await applyReceivedPayment(supabase, { ...row, provider_payment_id: paidId }, {
            providerPaymentId: paidId,
            status: "paid",
            providerStatus: paid?.providerStatus ?? "RECEIVED",
            paidAt: new Date().toISOString(),
            feeAmount: null,
            netAmount: null,
            amount: paid?.amount ?? null,
          });
          await confirmPaidAndClearLease(supabase, row.payment_id);
          result.paid += 1;
          continue;
        }

        if (cardResult.ok && cardResult.terminalize) {
          const outcome = await completeCancellation(supabase, row.payment_id);
          if (outcome === "already_paid") result.paid += 1;
          else result.expired += 1;
          continue;
        }

        await failCancellation(supabase, row.payment_id, cardResult.reason);
        result.failed += 1;
      } catch (error) {
        await failCancellation(supabase, row.payment_id, error);
        result.failed += 1;
      }
      continue;
    }

    let snapshot: GatewayPaymentSnapshot | null = null;
    try {
      snapshot = await gateway.getPayment({
        organizationId: row.organization_id,
        providerPaymentId: row.provider_payment_id,
      });
    } catch (error) {
      if (isAsaasPaymentAlreadyDeletedError(error)) {
        try {
          const outcome = await completeCancellation(supabase, row.payment_id);
          if (outcome === "already_paid") result.paid += 1;
          else if (outcome === "expired" || outcome === "already_terminal") result.expired += 1;
          else result.skipped += 1;
        } catch (completeError) {
          await failCancellation(supabase, row.payment_id, completeError);
          result.failed += 1;
        }
        continue;
      }
      await failCancellation(supabase, row.payment_id, error);
      result.failed += 1;
      continue;
    }

    if (isPaidSnapshot(snapshot)) {
      try {
        await applyReceivedPayment(supabase, row, snapshot);
        await confirmPaidAndClearLease(supabase, row.payment_id);
        result.paid += 1;
      } catch (error) {
        await failCancellation(supabase, row.payment_id, error);
        result.failed += 1;
      }
      continue;
    }

    if (isGoneOrCancelledSnapshot(snapshot)) {
      try {
        const outcome = await completeCancellation(supabase, row.payment_id);
        if (outcome === "already_paid") result.paid += 1;
        else result.expired += 1;
      } catch (error) {
        await failCancellation(supabase, row.payment_id, error);
        result.failed += 1;
      }
      continue;
    }

    try {
      await gateway.cancelPayment({
        organizationId: row.organization_id,
        providerPaymentId: row.provider_payment_id,
        reason: "Hold de checkout de 10 minutos expirado.",
      });
      const outcome = await completeCancellation(supabase, row.payment_id);
      if (outcome === "already_paid") result.paid += 1;
      else result.expired += 1;
    } catch (error) {
      if (isAsaasPaymentAlreadyDeletedError(error)) {
        try {
          const outcome = await completeCancellation(supabase, row.payment_id);
          if (outcome === "already_paid") result.paid += 1;
          else result.expired += 1;
        } catch (completeError) {
          await failCancellation(supabase, row.payment_id, completeError);
          result.failed += 1;
        }
        continue;
      }

      if (isAsaasPaymentNotDeletableError(error)) {
        try {
          const fresh = await gateway.getPayment({
            organizationId: row.organization_id,
            providerPaymentId: row.provider_payment_id,
          });
          if (isPaidSnapshot(fresh)) {
            await applyReceivedPayment(supabase, row, fresh);
            await confirmPaidAndClearLease(supabase, row.payment_id);
            result.paid += 1;
            continue;
          }
          await failCancellation(supabase, row.payment_id, error);
          result.failed += 1;
        } catch (reconcileError) {
          await failCancellation(supabase, row.payment_id, reconcileError);
          result.failed += 1;
        }
        continue;
      }

      if (isAsaasRetryableError(error)) {
        await failCancellation(supabase, row.payment_id, error);
        result.failed += 1;
        continue;
      }

      await failCancellation(supabase, row.payment_id, error);
      result.failed += 1;
    }
  }

  return result;
}
