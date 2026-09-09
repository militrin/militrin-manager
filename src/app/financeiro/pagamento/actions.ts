"use server";

import { revalidatePath } from "next/cache";
import { assertPermission, PermissionDeniedError } from "@/lib/admin/permissions";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { executeAdminPaymentRefund } from "@/lib/payments/admin-refund";
import { tryGetPaymentGatewayProviderForAccountKey } from "@/lib/payments/get-gateway-provider";

export type AdminRefundActionState = {
  success: boolean;
  status: string;
  message: string;
  attemptId?: string;
};

function fail(message: string, status = "failed"): AdminRefundActionState {
  return { success: false, status, message };
}

export async function requestAdminPaymentRefundAction(input: {
  paymentId: string;
  reasonCode: string;
  reasonText?: string | null;
  cancelTickets: boolean;
  confirmPhrase: string;
  mode?: "execute" | "reconcile";
}): Promise<AdminRefundActionState> {
  const supabase = await createServerSupabaseClient();
  const service = createServiceRoleSupabaseClient();

  const result = await executeAdminPaymentRefund(
    {
      paymentId: input.paymentId,
      reasonCode: input.reasonCode,
      reasonText: input.reasonText,
      cancelTickets: input.cancelTickets,
      confirmPhrase: input.confirmPhrase,
      mode: input.mode ?? "execute",
    },
    {
      assertAuthorized: () => assertPermission("finance.refund"),
      accountKeyConfigured: (accountKey) => Boolean(tryGetPaymentGatewayProviderForAccountKey(accountKey)),
      loadPayment: async (paymentId) => {
        const { data, error } = await supabase
          .from("payments")
          .select("id,organization_id,order_id,event_id,provider,payment_status,payment_method,price_origin,gateway_payment_id,gateway_account_key,gateway_environment,final_amount,amount,refund_status")
          .eq("id", paymentId)
          .maybeSingle();
        if (error) throw error;
        return data;
      },
      beginAttempt: async (beginInput) => {
        const { data, error } = await supabase.rpc("begin_admin_payment_refund", {
          p_payment_id: beginInput.paymentId,
          p_reason_code: beginInput.reasonCode,
          p_reason_text: beginInput.reasonText ?? null,
          p_cancel_tickets: beginInput.cancelTickets,
        });
        if (error) throw new Error(error.message);
        return (data ?? {}) as Record<string, unknown> as {
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
      },
      markAttempt: async (attemptId, status, failureText, gatewayResponse) => {
        const { error } = await service.rpc("mark_admin_payment_refund_attempt", {
          p_attempt_id: attemptId,
          p_status: status,
          p_failure_text: failureText ?? null,
          p_gateway_response: gatewayResponse ?? {},
        });
        if (error) throw new Error(error.message);
      },
      applyGatewayStatus: async (applyInput) => {
        const { error } = await service.rpc("apply_gateway_payment_status", {
          p_provider: applyInput.provider,
          p_provider_payment_id: applyInput.providerPaymentId,
          p_provider_status: applyInput.providerStatus,
          p_internal_status: applyInput.internalStatus,
          p_expected_gateway_account_key: applyInput.expectedAccountKey,
          p_event_type: applyInput.eventType ?? null,
        });
        if (error) throw new Error(error.message);
      },
      notifyFailure: async (paymentId) => {
        const { error } = await service.rpc("notify_payment_refund_outcome", {
          p_payment_id: paymentId,
          p_type: "PAYMENT_REFUND_FAILED",
          p_title: "Falha ao estornar pagamento",
          p_body: "Não foi possível concluir o estorno administrativo. Verifique o pagamento e tente conciliar.",
        });
        if (error) throw new Error(error.message);
      },
      getGateway: (accountKey) => {
        const provider = tryGetPaymentGatewayProviderForAccountKey(accountKey);
        if (!provider) {
          throw new Error("A conta Asaas original desta cobrança não está configurada.");
        }
        return provider;
      },
    },
  );

  if (result.status !== "forbidden") {
    revalidatePath(`/financeiro/pagamento/${input.paymentId}`);
    revalidatePath("/financeiro");
    revalidatePath("/painel");
  }

  if (result.status === "forbidden") {
    return fail(result.message, "forbidden");
  }

  return {
    success: result.ok,
    status: result.status,
    message: result.message,
    attemptId: result.attemptId,
  };
}

export async function requestAdminPaymentRefundFromForm(_: AdminRefundActionState, form: FormData): Promise<AdminRefundActionState> {
  try {
    return await requestAdminPaymentRefundAction({
      paymentId: String(form.get("paymentId") ?? ""),
      reasonCode: String(form.get("reasonCode") ?? ""),
      reasonText: String(form.get("reasonText") ?? "") || null,
      cancelTickets: String(form.get("cancelTickets") ?? "") === "true",
      confirmPhrase: String(form.get("confirmPhrase") ?? ""),
      mode: String(form.get("mode") ?? "execute") === "reconcile" ? "reconcile" : "execute",
    });
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return fail("Sem permissão para estornar pagamento.", "forbidden");
    }
    return fail(error instanceof Error ? error.message : "Falha ao estornar pagamento.");
  }
}
