import { notFound, redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { cardPaymentReturnPath } from '@/lib/payments/card-return-url';
import { PaymentReturnClient } from './payment-return-client';

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Retorno da Fatura Asaas. Nao confirma pagamento.
 * Status so vem do banco local (webhook). Sem IDOR: get_cart_order_details
 * exige auth.uid() dono do pedido.
 */
export default async function PaymentReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ pedido?: string }>;
}) {
  const params = await searchParams;
  const orderId = String(params.pedido ?? '').trim();
  if (!isUuid(orderId)) notFound();

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/entrar?next=${encodeURIComponent(cardPaymentReturnPath(orderId))}`);
  }

  const { data, error } = await supabase.rpc('get_cart_order_details', { p_order_id: orderId });
  if (error || !data) notFound();

  const raw = data as Record<string, unknown>;
  const payment = (raw.payment ?? null) as Record<string, unknown> | null;
  if (!payment) notFound();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow-1),_transparent_38%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-10 text-slate-100 sm:px-6">
      <PaymentReturnClient
        orderId={orderId}
        orderNumber={raw.order_number ? String(raw.order_number) : null}
        paymentStatus={String(payment.payment_status ?? 'pending')}
        lastGatewayAttemptStatus={payment.last_gateway_attempt_status ? String(payment.last_gateway_attempt_status) : null}
        checkoutUrl={payment.checkout_url ? String(payment.checkout_url) : null}
        expiresAt={payment.expires_at ? String(payment.expires_at) : null}
        gatewayChargeReusable={payment.gateway_charge_reusable !== false}
      />
    </main>
  );
}
