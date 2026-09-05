import type { SupabaseClient } from "@supabase/supabase-js";
import { getPaymentGatewayProvider, tryGetPaymentGatewayProviderForAccountKey } from "@/lib/payments/get-gateway-provider";

/**
 * Chamada logo apos `apply_cart_coupon` (ou qualquer mutacao de carrinho que
 * possa ter invalidado um PIX/cartao). Le-e-limpa (atomicamente, via
 * `pop_pending_external_cancellation`) a marca deixada por `apply_cart_coupon`
 * quando o total do pedido muda com uma cobranca de gateway real ja
 * associada, e pede ao provider da CONTA HISTORICA para cancelar essa
 * cobranca -- nunca a "conta ativa de hoje" se o rotulo for outro.
 *
 * Best-effort deliberado: se o cancelamento remoto falhar a acao do carrinho
 * NAO deve falhar por causa disso.
 */
export async function cancelPendingExternalCharge(supabase: SupabaseClient, orderId: string): Promise<void> {
  const { data, error } = await supabase.rpc("pop_pending_external_cancellation", { p_order_id: orderId });
  if (error) {
    console.error("[payments] pop_pending_external_cancellation_failed", { orderId, error });
    return;
  }

  const pending = (Array.isArray(data) ? data[0] : data) as
    | { payment_id: string; organization_id: string; provider: string | null; provider_payment_id: string | null }
    | null;

  if (!pending?.provider || !pending.provider_payment_id) return;

  const { data: paymentRow } = await supabase
    .from("payments")
    .select("gateway_account_key")
    .eq("id", pending.payment_id)
    .maybeSingle();

  const storedAccountKey = paymentRow?.gateway_account_key ? String(paymentRow.gateway_account_key) : null;
  const gateway = pending.provider === "asaas"
    ? tryGetPaymentGatewayProviderForAccountKey(storedAccountKey)
    : getPaymentGatewayProvider("fake");

  if (!gateway) {
    console.warn("[payments] skip_cancel_unknown_or_legacy_account", {
      orderId,
      provider: pending.provider,
    });
    return;
  }

  const { data: chargeIds } = await supabase.rpc("list_live_gateway_charge_ids", {
    p_payment_id: pending.payment_id,
  });
  const ids = [...new Set(
    [
      pending.provider_payment_id,
      ...(Array.isArray(chargeIds) ? chargeIds.map((id) => String(id)) : []),
    ].map((id) => String(id ?? "").trim()).filter(Boolean),
  )];

  try {
    for (const providerPaymentId of ids) {
      await gateway.cancelPayment({
        organizationId: pending.organization_id,
        providerPaymentId,
        reason: "Carrinho alterado: valor do pedido mudou apos a cobranca ter sido gerada.",
      });
    }
    await supabase.rpc("mark_gateway_charges_not_reusable", {
      p_payment_id: pending.payment_id,
    });
  } catch (cancelError) {
    console.error("[payments] cancel_pending_external_charge_failed", {
      orderId,
      provider: pending.provider,
      providerPaymentId: pending.provider_payment_id,
      error: cancelError instanceof Error ? cancelError.message : String(cancelError),
    });
  }
}
