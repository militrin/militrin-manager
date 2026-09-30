'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { deliverOperationalProductItemAction } from '@/app/operacoes/actions';
import type { AdditionalItemSource } from '@/lib/operations/additional-product-items';

export type DeliverProductConfirmResult = { success: boolean; message?: string | null };

export function DeliverProductConfirmDialog({
  productName,
  quantity,
  orderReference,
  customerName,
  onConfirm,
  onCancel,
}: {
  productName: string;
  quantity: number;
  orderReference: string;
  customerName?: string | null;
  onConfirm: () => Promise<DeliverProductConfirmResult | void>;
  onCancel: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleConfirm() {
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await onConfirm();
      if (result && 'success' in result && !result.success) {
        setMessage(result.message ?? 'Não foi possível confirmar a entrega.');
        return;
      }
      onCancel();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="deliver-product-title"
        className="w-full max-w-md rounded-t-3xl border border-slate-700 bg-slate-900 p-5 text-slate-100 shadow-2xl sm:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id="deliver-product-title" className="text-lg font-semibold">Confirmar entrega</h3>
        <div className="mt-4 space-y-2 rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm">
          <p className="font-semibold text-white">{productName}</p>
          <p className="text-slate-300">Quantidade: {quantity}</p>
          <p className="text-slate-300">Pedido {orderReference}</p>
          {customerName ? <p className="text-slate-300">Cliente: {customerName}</p> : null}
        </div>
        <p className="mt-3 text-sm text-slate-400">Confirme somente após entregar o produto ao participante.</p>
        {message ? <p className="mt-3 text-sm text-amber-200" role="status">{message}</p> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="h-10 rounded-xl border border-slate-700 px-4 text-sm text-slate-300 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={submitting}
            className="h-10 rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-emerald-950 disabled:opacity-50"
          >
            {submitting ? 'Confirmando...' : 'Confirmar entrega'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DeliverProductButton({
  source,
  itemId,
  productName,
  quantity,
  orderReference,
  customerName,
  label = 'Marcar como entregue',
  className,
  onDelivered,
}: {
  source: AdditionalItemSource;
  itemId: string;
  productName: string;
  quantity: number;
  orderReference: string;
  customerName?: string | null;
  label?: string;
  className?: string;
  onDelivered?: (result: DeliverProductConfirmResult) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className ?? 'rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs font-semibold text-emerald-200'}
      >
        {label}
      </button>
      {feedback ? <p className="text-xs text-emerald-200" role="status">{feedback}</p> : null}
      {open ? (
        <DeliverProductConfirmDialog
          productName={productName}
          quantity={quantity}
          orderReference={orderReference}
          customerName={customerName}
          onCancel={() => setOpen(false)}
          onConfirm={async () => {
            const result = await deliverOperationalProductItemAction({ source, item_id: itemId });
            if (result.success) {
              setFeedback(result.message ?? 'Produto entregue.');
              onDelivered?.(result);
              router.refresh();
            }
            return result;
          }}
        />
      ) : null}
    </>
  );
}
