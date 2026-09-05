'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { generatePublicOrderCardAction, getPublicOrderPaymentStatusAction } from '@/app/inscricao/actions';
import { canReuseCardCheckout } from '@/lib/checkout/pix-payment-status';

type PaymentReturnClientProps = {
  orderId: string;
  orderNumber: string | null;
  paymentStatus: string;
  lastGatewayAttemptStatus: string | null;
  checkoutUrl: string | null;
  expiresAt: string | null;
  gatewayChargeReusable: boolean;
};

export function PaymentReturnClient({
  orderId,
  orderNumber,
  paymentStatus: initialStatus,
  lastGatewayAttemptStatus: initialAttempt,
  checkoutUrl: initialCheckoutUrl,
  expiresAt: initialExpiresAt,
  gatewayChargeReusable: initialReusable,
}: PaymentReturnClientProps) {
  const [paymentStatus, setPaymentStatus] = useState(initialStatus);
  const [attemptStatus, setAttemptStatus] = useState(initialAttempt);
  const [checkoutUrl, setCheckoutUrl] = useState(initialCheckoutUrl);
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt);
  const [chargeReusable, setChargeReusable] = useState(initialReusable);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const inFlight = useRef(false);

  const pending = paymentStatus === 'pending' || paymentStatus === 'processing';
  const refused = pending && attemptStatus === 'refused';
  const paid = paymentStatus === 'paid';
  const canReuseInvoice = canReuseCardCheckout({
    payment_status: paymentStatus,
    checkout_url: checkoutUrl,
    expires_at: expiresAt,
    gateway_charge_reusable: chargeReusable,
  });

  useEffect(() => {
    if (!pending) return;

    let cancelled = false;

    async function refresh() {
      if (inFlight.current || cancelled) return;
      inFlight.current = true;
      try {
        const result = await getPublicOrderPaymentStatusAction(orderId);
        if (cancelled || !result.success) return;
        setPaymentStatus(String(result.payment_status ?? 'pending'));
        setAttemptStatus(result.last_gateway_attempt_status);
        setCheckoutUrl(result.checkout_url);
        setExpiresAt(result.expires_at);
        setChargeReusable(result.gateway_charge_reusable !== false);
      } finally {
        inFlight.current = false;
      }
    }

    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 2500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [orderId, pending]);

  const reference = orderNumber ? `Pedido ${orderNumber}` : 'Seu pedido';

  async function retryPayment() {
    if (isRetrying) return;
    setIsRetrying(true);
    setRetryMessage(null);
    try {
      const result = await generatePublicOrderCardAction(orderId);
      if (!result.success || !result.payment?.checkout_url) {
        setRetryMessage(result.success ? 'Nao foi possivel gerar uma nova cobranca.' : result.message);
        return;
      }
      window.location.assign(String(result.payment.checkout_url));
    } finally {
      setIsRetrying(false);
    }
  }

  if (paymentStatus === 'cancelled' || paymentStatus === 'canceled') {
    return (
      <section className="mx-auto max-w-lg rounded-3xl border border-slate-700 bg-slate-950 p-8 text-center">
        <AlertTriangle className="mx-auto h-12 w-12 text-slate-400" aria-hidden />
        <h1 className="mt-3 text-2xl font-semibold text-slate-100">Pagamento cancelado</h1>
        <p className="mt-2 text-sm text-slate-300">Este pagamento foi cancelado. Inicie uma nova inscricao para continuar.</p>
      </section>
    );
  }

  if (paymentStatus === 'expired') {
    return (
      <section className="mx-auto max-w-lg rounded-3xl border border-amber-500/40 bg-amber-950/20 p-8 text-center">
        <Clock className="mx-auto h-12 w-12 text-amber-400" aria-hidden />
        <h1 className="mt-3 text-2xl font-semibold text-amber-100">Pagamento expirado</h1>
        <p className="mt-2 text-sm text-amber-200/90">
          O prazo desta cobranca terminou. Se o cartao ja foi aprovado, aguarde a confirmacao. Caso contrario, tente novamente.
        </p>
        <button
          type="button"
          onClick={() => void retryPayment()}
          disabled={isRetrying}
          className="mt-5 inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50"
        >
          {isRetrying ? 'Gerando nova cobranca...' : 'Tentar pagamento novamente'}
        </button>
        {retryMessage ? <p className="mt-3 text-sm text-red-200">{retryMessage}</p> : null}
      </section>
    );
  }

  if (paid) {
    return (
      <section className="mx-auto max-w-lg rounded-3xl border border-emerald-500/40 bg-emerald-950/30 p-8 text-center">
        <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-400" aria-hidden />
        <h1 className="mt-3 text-2xl font-semibold text-emerald-100">Pagamento confirmado</h1>
        <p className="mt-2 text-sm text-emerald-200/90">
          {reference} foi confirmado. Os ingressos ja podem ser acessados na sua conta.
        </p>
        <Link
          href="/minha-conta/ingressos"
          className="mt-5 inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950"
        >
          Ver meus ingressos
        </Link>
      </section>
    );
  }

  if (refused) {
    return (
      <section className="mx-auto max-w-lg rounded-3xl border border-red-500/40 bg-red-950/20 p-8 text-center">
        <AlertTriangle className="mx-auto h-12 w-12 text-red-400" aria-hidden />
        <h1 className="mt-3 text-2xl font-semibold text-red-100">Cartao recusado. Tente novamente.</h1>
        <p className="mt-2 text-sm text-red-200/90">
          A tentativa nao foi autorizada. Nenhum ingresso foi emitido. Voce pode usar a mesma pagina de pagamento com outro cartao.
        </p>
        {canReuseInvoice && checkoutUrl ? (
          <a
            href={checkoutUrl}
            className="mt-5 inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950"
          >
            Voltar ao pagamento
          </a>
        ) : (
          <button
            type="button"
            onClick={() => void retryPayment()}
            disabled={isRetrying}
            className="mt-5 inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50"
          >
            {isRetrying ? 'Gerando nova cobranca...' : 'Voltar ao pagamento'}
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-lg rounded-3xl border border-amber-500/40 bg-amber-950/20 p-8 text-center">
      <Clock className="mx-auto h-12 w-12 text-amber-400" aria-hidden />
      <h1 className="mt-3 text-2xl font-semibold text-amber-100">Pagamento ainda não confirmado.</h1>
      <p className="mt-2 text-sm text-amber-200/90">Se a tentativa não foi concluída, você pode tentar novamente.</p>
      <p className="mt-4 text-xs text-slate-400">{reference}</p>
      {canReuseInvoice && checkoutUrl ? (
        <a
          href={checkoutUrl}
          className="mt-5 inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950"
        >
          Tentar pagamento novamente
        </a>
      ) : (
        <button
          type="button"
          onClick={() => void retryPayment()}
          disabled={isRetrying}
          className="mt-5 inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50"
        >
          {isRetrying ? 'Gerando nova cobranca...' : 'Tentar pagamento novamente'}
        </button>
      )}
      {retryMessage ? <p className="mt-3 text-sm text-red-200">{retryMessage}</p> : null}
    </section>
  );
}
