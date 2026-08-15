'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { MilitrinButton } from '@/components/militrin';
import { cancelAccountStoreOrderAction, simulateStoreOrderPaymentAction } from '@/lib/store/actions';

const canSimulatePayment = process.env.NODE_ENV === 'development';

export function StoreOrderActions({ storeOrderId, canCancel }: { storeOrderId: string; canCancel: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canSimulatePayment ? (
        <MilitrinButton
          size="sm"
          variant="success"
          disabled={pending}
          onClick={() => startTransition(async () => {
            const response = await simulateStoreOrderPaymentAction(storeOrderId, 'pix');
            setMessage(response.message);
            if (response.success) router.refresh();
          })}
        >
          {pending ? 'Processando...' : 'Pagar agora (simulado dev)'}
        </MilitrinButton>
      ) : null}
      {canCancel ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(async () => {
            const response = await cancelAccountStoreOrderAction(storeOrderId);
            setMessage(response.message);
            if (response.success) router.refresh();
          })}
          className="inline-flex h-9 items-center rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 text-xs text-rose-200 disabled:opacity-50"
        >
          Cancelar pedido
        </button>
      ) : null}
      {message ? <p className="text-xs text-slate-400" role="status">{message}</p> : null}
    </div>
  );
}
