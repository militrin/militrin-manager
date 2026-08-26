'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import { AlertTriangle, CheckCircle2, Clock, Copy, QrCode as QrCodeIcon, XCircle } from 'lucide-react';
import { canRegeneratePix, formatPixCountdown, resolvePixDisplayStatus } from '@/lib/checkout/pix-payment-status';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

export type PixPaymentCardProps = {
  amount: number;
  /** Status cru de payments.payment_status (ou equivalente) -- so esta funcao traduz. */
  paymentStatus: string;
  pixCode: string | null;
  pixQrCode: string | null;
  /** Segundos restantes ate expires_at, ja calculados pelo chamador (relogio unico da tela). null = sem prazo aplicavel. */
  countdownSeconds: number | null;
  /** true somente quando o provider efetivo (persistido no pagamento) e 'fake'. Nunca aparece com Asaas. */
  isFakePaymentProvider: boolean;
  isSimulating: boolean;
  onSimulatePayment: () => void;
  onRegeneratePix?: () => void;
  isRegeneratingPix?: boolean;
};

/**
 * Bloco de pagamento PIX do checkout publico. Puramente apresentacional --
 * nao decide nada sobre preco, reserva, titularidade ou emissao de ticket.
 * `onSimulatePayment`/`onRegeneratePix` sao responsabilidade de quem usa este
 * componente (Server Actions ja existentes); este componente so oferece a
 * interacao. Preparado para receber a Asaas real sem mudanca estrutural: o
 * dia que pixQrCode/pixCode vierem de uma cobranca Asaas em vez do
 * FakeGatewayProvider, nada aqui muda.
 */
export function PixPaymentCard({
  amount,
  paymentStatus,
  pixCode,
  pixQrCode,
  countdownSeconds,
  isFakePaymentProvider,
  isSimulating,
  onSimulatePayment,
  onRegeneratePix,
  isRegeneratingPix,
}: PixPaymentCardProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const displayStatus = resolvePixDisplayStatus(paymentStatus, countdownSeconds);

  async function handleCopy() {
    if (!pixCode) return;
    try {
      await navigator.clipboard.writeText(pixCode);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (displayStatus === 'paid') {
    return (
      <div className="rounded-3xl border border-emerald-500/40 bg-emerald-950/30 p-6 text-center sm:p-8">
        <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-400" aria-hidden />
        <h3 className="mt-3 text-xl font-semibold text-emerald-100">Pagamento confirmado</h3>
        <p className="mt-1 text-sm text-emerald-200/90">Seu ingresso foi emitido com sucesso.</p>
      </div>
    );
  }

  if (displayStatus === 'cancelled') {
    return (
      <div className="rounded-3xl border border-slate-700 bg-slate-950 p-6 text-center sm:p-8">
        <XCircle className="mx-auto h-12 w-12 text-slate-400" aria-hidden />
        <h3 className="mt-3 text-xl font-semibold text-slate-100">Pagamento cancelado</h3>
        <p className="mt-1 text-sm text-slate-300">Este pagamento foi cancelado. Inicie uma nova inscrição para continuar.</p>
      </div>
    );
  }

  if (displayStatus === 'expired') {
    const canRegenerate = canRegeneratePix(paymentStatus) && Boolean(onRegeneratePix);
    return (
      <div className="rounded-3xl border border-amber-500/40 bg-amber-950/20 p-6 text-center sm:p-8">
        <Clock className="mx-auto h-12 w-12 text-amber-400" aria-hidden />
        <h3 className="mt-3 text-xl font-semibold text-amber-100">Pagamento expirado</h3>
        <p className="mt-1 text-sm text-amber-200/90">O prazo para pagar este PIX terminou e a reserva não está mais garantida.</p>
        {canRegenerate ? (
          <button
            type="button"
            onClick={onRegeneratePix}
            disabled={isRegeneratingPix}
            className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50 sm:w-auto sm:min-w-[220px]"
          >
            {isRegeneratingPix ? 'Gerando novo PIX...' : 'Gerar novo pagamento'}
          </button>
        ) : null}
      </div>
    );
  }

  if (displayStatus === 'error') {
    return (
      <div className="rounded-3xl border border-red-500/40 bg-red-950/20 p-6 text-center sm:p-8">
        <AlertTriangle className="mx-auto h-12 w-12 text-red-400" aria-hidden />
        <h3 className="mt-3 text-xl font-semibold text-red-100">Erro no pagamento</h3>
        <p className="mt-1 text-sm text-red-200/90">Não conseguimos confirmar o status do seu pagamento agora. Atualize a página em instantes.</p>
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-slate-700 bg-slate-950 p-5 sm:p-6">
      <div className="text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium uppercase tracking-wide text-amber-300">
          <Clock className="h-3.5 w-3.5" aria-hidden />
          Aguardando pagamento
        </span>
        <p className="mt-3 text-3xl font-bold text-white">{money(amount)}</p>
        {countdownSeconds !== null ? (
          <p className="mt-1 text-sm text-slate-400">
            Expira em <strong className="tabular-nums text-slate-200">{formatPixCountdown(countdownSeconds)}</strong>
          </p>
        ) : null}
      </div>

      {pixQrCode ? (
        <div className="mx-auto mt-5 w-full max-w-[260px] rounded-2xl border border-slate-700 bg-white p-3">
          <Image
            src={pixQrCode}
            alt="QR Code para pagamento PIX"
            width={260}
            height={260}
            unoptimized
            className="h-auto w-full"
          />
        </div>
      ) : (
        <div className="mx-auto mt-5 flex h-52 w-full max-w-[260px] items-center justify-center rounded-2xl border border-dashed border-slate-700 bg-slate-900 text-slate-500">
          <QrCodeIcon className="h-10 w-10" aria-hidden />
        </div>
      )}

      {isFakePaymentProvider ? (
        <p className="mt-2 text-center text-xs font-semibold uppercase tracking-wide text-sky-400">PIX de teste</p>
      ) : null}

      {pixCode ? (
        <div className="mt-4 flex items-stretch gap-2">
          <input
            readOnly
            value={pixCode}
            onFocus={(event) => event.currentTarget.select()}
            aria-label="Código PIX copia e cola"
            className="h-11 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs text-slate-300"
          />
          <button
            type="button"
            onClick={handleCopy}
            className="flex h-11 min-w-[110px] shrink-0 items-center justify-center gap-1.5 rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-emerald-950"
          >
            <Copy className="h-4 w-4" aria-hidden />
            {copied ? 'Copiado!' : 'Copiar'}
          </button>
        </div>
      ) : null}

      <p className="mt-4 text-center text-sm text-slate-400">
        Seu ingresso será liberado automaticamente após a confirmação do pagamento.
      </p>

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
          <p className="mt-2 text-xs text-slate-500">Disponível apenas em ambiente de testes.</p>
        </div>
      ) : null}
    </div>
  );
}
