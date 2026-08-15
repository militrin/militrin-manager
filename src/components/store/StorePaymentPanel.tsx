'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MilitrinButton } from '@/components/militrin';
import { cancelAccountStoreOrderAction, simulateStoreOrderPaymentAction } from '@/lib/store/actions';
import { money } from './store-item-controls';

const canSimulatePayment = process.env.NODE_ENV === 'development';

export type StorePaymentState = {
  storeOrderId: string;
  orderNumber: string;
  finalAmount: number;
  paymentMethod: 'pix' | 'credit_card';
  pixCode: string | null;
  pixQrCode: string | null;
  expiresAt: string | null;
  status: 'awaiting_payment' | 'paid';
};

export function StorePaymentPanel({ state, onChange }: { state: StorePaymentState; onChange: (next: StorePaymentState) => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!state.expiresAt || state.status === 'paid') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.expiresAt, state.status]);

  const remainingSeconds = state.expiresAt ? Math.max(0, Math.floor((new Date(state.expiresAt).getTime() - now) / 1000)) : null;

  function cancel() {
    startTransition(async () => {
      const response = await cancelAccountStoreOrderAction(state.storeOrderId);
      setMessage(response.message);
      if (response.success) router.refresh();
    });
  }

  function simulatePaid() {
    startTransition(async () => {
      const response = await simulateStoreOrderPaymentAction(state.storeOrderId, state.paymentMethod);
      setMessage(response.message);
      if (response.success) {
        onChange({ ...state, status: 'paid' });
        router.refresh();
      }
    });
  }

  if (state.status === 'paid') {
    return (
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
        <p className="text-sm font-semibold text-emerald-200">Pagamento confirmado!</p>
        <p className="mt-1 text-xs text-emerald-100/80">Pedido {state.orderNumber} — {money(state.finalAmount)}. A organização vai preparar seus itens.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-(--brand-400)/30 bg-(--brand-500)/10 p-4">
      <p className="text-sm font-semibold text-white">Pedido {state.orderNumber} — {money(state.finalAmount)}</p>

      {state.paymentMethod === 'pix' && state.pixCode ? (
        <div className="mt-3 space-y-3 rounded-2xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-200">
          <p className="font-medium">Use o código PIX abaixo:</p>
          <textarea readOnly value={state.pixCode} className="h-24 w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs" />
          {state.pixQrCode ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={state.pixQrCode} alt="QR Code PIX" className="h-44 w-44 rounded-xl border border-slate-700 bg-white p-2" />
          ) : null}
          {remainingSeconds !== null ? (
            <p className="text-xs text-slate-400">
              {remainingSeconds > 0 ? `Expira em ${Math.floor(remainingSeconds / 60)}m ${remainingSeconds % 60}s` : 'Código expirado — cancele e tente novamente.'}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-200">Pagamento pendente. Aguarde a confirmação da organização.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canSimulatePayment ? (
          <MilitrinButton size="sm" variant="success" disabled={pending} onClick={simulatePaid}>
            {pending ? 'Processando...' : 'Pagar agora (simulado dev)'}
          </MilitrinButton>
        ) : null}
        <button type="button" disabled={pending} onClick={cancel} className="inline-flex h-9 items-center rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 text-xs text-rose-200 disabled:opacity-50">
          Cancelar pedido
        </button>
      </div>
      {message ? <p className="mt-2 text-xs text-slate-400" role="status">{message}</p> : null}
    </div>
  );
}
