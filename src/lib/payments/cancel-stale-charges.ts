import type { SupabaseClient } from "@supabase/supabase-js";
import { canUseCurrentGatewayForCharge, getPaymentGatewayProviderByName } from "@/lib/payments/get-gateway-provider";

/**
 * Chamada logo apos `apply_cart_coupon` (ou qualquer mutacao de carrinho que
 * possa ter invalidado um PIX). Le-e-limpa (atomicamente, via
 * `pop_pending_external_cancellation`) a marca deixada por `apply_cart_coupon`
 * quando o total do pedido muda com uma cobranca de gateway real ja
 * associada, e pede ao provider correspondente para cancelar essa cobranca --
 * assim ela para de ser pagavel no gateway com o preco antigo.
 *
 * Best-effort deliberado: se o cancelamento remoto falhar (gateway fora do
 * ar, id ja cancelado la, etc.) a acao do carrinho NAO deve falhar por causa
 * disso -- o vinculo local (payments.gateway_payment_id) ja foi nulado pelo
 * `apply_cart_coupon`, entao nenhum webhook futuro para aquela cobranca sera
 * mais reconhecido (record/apply so acham o pagamento por
 * provider+gateway_payment_id). A expiracao/reconciliacao manual e a rede de
 * seguranca final para o caso raro de a cobranca continuar tecnicamente
 * pagavel no lado do gateway.
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

  if (!canUseCurrentGatewayForCharge(paymentRow?.gateway_account_key ? String(paymentRow.gateway_account_key) : null)) {
    console.warn("[payments] skip_cancel_foreign_or_legacy_account", {
      orderId,
      provider: pending.provider,
    });
    return;
  }

  try {
    const gateway = getPaymentGatewayProviderByName(pending.provider, pending.organization_id);
    await gateway.cancelPayment({
      organizationId: pending.organization_id,
      providerPaymentId: pending.provider_payment_id,
      reason: "Carrinho alterado: valor do pedido mudou apos a cobranca ter sido gerada.",
    });
  } catch (error) {
    console.error("[payments] cancel_pending_external_charge_failed", {
      orderId,
      provider: pending.provider,
      providerPaymentId: pending.provider_payment_id,
      error,
    });
  }
}
