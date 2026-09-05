'use client';

import { AlertTriangle, CheckCircle2, Clock, CreditCard, XCircle } from 'lucide-react';
import { canRegeneratePix, resolvePixDisplayStatus } from '@/lib/checkout/pix-payment-status';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

export type CardPaymentCardProps = {
  amount: number;
  paymentStatus: string;
  checkoutUrl: string | null;
  installments: number | null;
  countdownSeconds: number | null;
  lastGatewayAttemptStatus?: string | null;
  canReuseInvoice?: boolean;
  isFakePaymentProvider: boolean;
  isSimulating: boolean;
  onSimulatePayment: () => void;
  onRetryCheckout?: () => void;
  isRetrying?: boolean;
  confirmedHref?: string;
  confirmedLabel?: string;
};

/**
 * Checkout de cartao do Militrin. Nao coleta PAN/CVV: o pagador informa
 * os dados na pagina hospedada do Asaas (`checkoutUrl` = invoiceUrl).
 * Pedido so vira pago depois do webhook/status canonico.
 *
 * Recusa sandbox pode manter PENDING sem PAYMENT_CREDIT_CARD_CAPTURE_REFUSED.
 * Sem last_gateway_attempt_status=refused, a UI e neutra -- nunca failed.
 */
export function CardPaymentCard({
  amount,
  paymentStatus,
  checkoutUrl,
  installments,
  countdownSeconds,
  lastGatewayAttemptStatus,
  canReuseInvoice = false,
  isFakePaymentProvider,
  isSimulating,
  onSimulatePayment,
  onRetryCheckout,
  isRetrying,
  confirmedHref,
  confirmedLabel,
}: CardPaymentCardProps) {
  const displayStatus = resolvePixDisplayStatus(paymentStatus, countdownSeconds);
  const parcelCount = Math.max(1, Math.floor(Number(installments ?? 1) || 1));
  const installmentAmount = parcelCount > 1 ? amount / parcelCount : amount;
  const attemptRefused = displayStatus === 'pending' && String(lastGatewayAttemptStatus ?? '') === 'refused';
  const reuseUrl = canReuseInvoice && checkoutUrl ? checkoutUrl : null;

  if (displayStatus === 'paid') {
    return (
      <div className="rounded-3xl border border-emerald-500/40 bg-emerald-950/30 p-6 text-center sm:p-8">
        <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-400" aria-hidden />
        <h3 className="mt-3 text-xl font-semibold text-emerald-100">Pagamento aprovado</h3>
        <p className="mt-1 text-sm text-emerald-200/90">
          Seu pagamento com cartao foi confirmado. Os ingressos aparecem em Minha Conta assim que a emissao for concluida.
        </p>
        {confirmedHref ? (
          <a
            href={confirmedHref}
            className="mt-4 inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950"
          >
            {confirmedLabel ?? 'Ver meus ingressos'}
          </a>
        ) : null}
      </div>
    );
  }

  if (displayStatus === 'cancelled') {
    return (
      <div className="rounded-3xl border border-slate-700 bg-slate-950 p-6 text-center sm:p-8">
        <XCircle className="mx-auto h-12 w-12 text-slate-400" aria-hidden />
        <h3 className="mt-3 text-xl font-semibold text-slate-100">Pagamento cancelado</h3>
        <p className="mt-1 text-sm text-slate-300">Este pagamento foi cancelado. Inicie uma nova inscricao para continuar.</p>
      </div>
    );
  }

  if (displayStatus === 'expired') {
    const canRetry = canRegeneratePix(paymentStatus) && Boolean(onRetryCheckout);
    return (
      <div className="rounded-3xl border border-amber-500/40 bg-amber-950/20 p-6 text-center sm:p-8">
        <Clock className="mx-auto h-12 w-12 text-amber-400" aria-hidden />
        <h3 className="mt-3 text-xl font-semibold text-amber-100">Pagamento expirado</h3>
        <p className="mt-1 text-sm text-amber-200/90">
          O prazo desta cobranca terminou. Se o cartao ja foi aprovado, aguarde a confirmacao. Caso contrario, tente novamente.
        </p>
        {canRetry ? (
          <button
            type="button"
            onClick={onRetryCheckout}
            disabled={isRetrying}
            className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50 sm:w-auto sm:min-w-[220px]"
          >
            {isRetrying ? 'Gerando nova cobranca...' : 'Tentar pagamento novamente'}
          </button>
        ) : null}
      </div>
    );
  }

  if (attemptRefused) {
    return (
      <div className="rounded-3xl border border-red-500/40 bg-red-950/20 p-6 text-center sm:p-8">
        <AlertTriangle className="mx-auto h-12 w-12 text-red-400" aria-hidden />
        <h3 className="mt-3 text-xl font-semibold text-red-100">Cartao recusado. Tente novamente.</h3>
        <p className="mt-1 text-sm text-red-200/90">
          A tentativa nao foi autorizada. Nenhum ingresso foi emitido. Voce pode usar a mesma pagina de pagamento com outro cartao.
        </p>
        {reuseUrl && !isFakePaymentProvider ? (
          <a
            href={reuseUrl}
            className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 sm:w-auto sm:min-w-[220px]"
          >
            Voltar ao pagamento
          </a>
        ) : onRetryCheckout ? (
          <button
            type="button"
            onClick={onRetryCheckout}
            disabled={isRetrying}
            className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50 sm:w-auto sm:min-w-[220px]"
          >
            {isRetrying ? 'Gerando nova cobranca...' : 'Voltar ao pagamento'}
          </button>
        ) : null}
      </div>
    );
  }

  if (displayStatus === 'error') {
    return (
      <div className="rounded-3xl border border-red-500/40 bg-red-950/20 p-6 text-center sm:p-8">
        <AlertTriangle className="mx-auto h-12 w-12 text-red-400" aria-hidden />
        <h3 className="mt-3 text-xl font-semibold text-red-100">Pagamento recusado</h3>
        <p className="mt-1 text-sm text-red-200/90">
          Nao foi possivel confirmar este pagamento. Nenhum ingresso foi emitido. Tente novamente.
        </p>
        {onRetryCheckout ? (
          <button
            type="button"
            onClick={onRetryCheckout}
            disabled={isRetrying}
            className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50 sm:w-auto sm:min-w-[220px]"
          >
            {isRetrying ? 'Gerando nova cobranca...' : 'Tentar pagamento novamente'}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-slate-700 bg-slate-950 p-5 sm:p-6">
      <div className="text-center">
        <Clock className="mx-auto h-10 w-10 text-amber-400" aria-hidden />
        <h3 className="mt-3 text-xl font-semibold text-amber-100">Pagamento ainda não confirmado.</h3>
        <p className="mt-2 text-sm text-slate-300">Se a tentativa não foi concluída, você pode tentar novamente.</p>
        <p className="mt-3 text-3xl font-bold text-white">{money(amount)}</p>
        {parcelCount > 1 ? (
          <p className="mt-1 text-sm text-slate-300">
            {parcelCount}x de <strong className="text-slate-100">{money(installmentAmount)}</strong>
          </p>
        ) : (
          <p className="mt-1 text-sm text-slate-400">Cartao a vista</p>
        )}
        <p className="mt-1 text-xs text-slate-500">Total: {money(amount)}</p>
      </div>

      <p className="mt-4 text-center text-sm text-slate-400">
        Voce sera direcionado para a pagina segura do Asaas para informar o cartao. O Militrin nao armazena numero nem CVV.
        O pedido so e confirmado depois da aprovacao.
      </p>

      {reuseUrl && !isFakePaymentProvider ? (
        <a
          href={reuseUrl}
          className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950"
        >
          <CreditCard className="h-4 w-4" aria-hidden />
          Tentar pagamento novamente
        </a>
      ) : onRetryCheckout ? (
        <button
          type="button"
          onClick={onRetryCheckout}
          disabled={isRetrying}
          className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50"
        >
          <CreditCard className="h-4 w-4" aria-hidden />
          {isRetrying ? 'Preparando pagamento...' : 'Tentar pagamento novamente'}
        </button>
      ) : null}

      {isFakePaymentProvider ? (
        <div className="mt-4 border-t border-slate-800 pt-4 text-center">
          <button
            type="button"
            onClick={onSimulatePayment}
            disabled={isSimulating}
            className="inline-flex h-11 w-full items-center justify-center rounded-2xl border border-sky-500/50 bg-sky-500/10 px-6 text-sm font-semibold text-sky-300 disabled:opacity-50 sm:w-auto"
          >
            {isSimulating ? 'Simulando...' : 'Simular pagamento aprovado'}
          </button>
          <p className="mt-2 text-xs text-slate-500">Disponivel apenas em ambiente de testes. Recusa real so existe no sandbox Asaas.</p>
        </div>
      ) : null}
    </div>
  );
}
