'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  cancelStoreOrderAction,
  confirmStoreOrderPaymentAction,
  deliverStoreOrderItemAction,
  undoStoreOrderItemDeliveryAction,
} from '../../actions';

export function OrderPaymentActions({ storeOrderId, status }: { storeOrderId: string; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  if (status !== 'pending') return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const response = await confirmStoreOrderPaymentAction(storeOrderId);
            setMessage(response.message);
            if (response.success) router.refresh();
          })
        }
        className="inline-flex h-9 items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200 disabled:opacity-50"
      >
        Confirmar pagamento
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const response = await cancelStoreOrderAction(storeOrderId, 'Cancelado pela administração');
            setMessage(response.message);
            if (response.success) router.refresh();
          })
        }
        className="inline-flex h-9 items-center rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 text-xs text-rose-200 disabled:opacity-50"
      >
        Cancelar pedido
      </button>
      {message ? <p className="text-xs text-slate-400" role="status">{message}</p> : null}
    </div>
  );
}

export function OrderItemActions({
  storeOrderId,
  itemId,
  status,
  hasQr,
}: {
  storeOrderId: string;
  itemId: string;
  status: string;
  hasQr: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasQr && (status === 'confirmed' || status === 'delivered') ? (
        <a
          href={`/api/loja/pedidos/${storeOrderId}/itens/${itemId}/qrcode`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center rounded-lg border border-cyan-500/40 px-2 text-[11px] text-cyan-200"
        >
          Baixar QR do item
        </a>
      ) : null}
      {status === 'confirmed' ? (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const response = await deliverStoreOrderItemAction(itemId);
              setMessage(response.message);
              if (response.success) router.refresh();
            })
          }
          className="inline-flex h-8 items-center rounded-lg border border-emerald-500/40 px-2 text-[11px] text-emerald-200 disabled:opacity-50"
        >
          Confirmar entrega
        </button>
      ) : null}
      {status === 'delivered' ? (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const response = await undoStoreOrderItemDeliveryAction(itemId);
              setMessage(response.message);
              if (response.success) router.refresh();
            })
          }
          className="inline-flex h-8 items-center rounded-lg border border-slate-700 px-2 text-[11px] text-slate-300 disabled:opacity-50"
        >
          Desfazer entrega
        </button>
      ) : null}
      {message ? <p className="text-xs text-slate-400" role="status">{message}</p> : null}
    </div>
  );
}
