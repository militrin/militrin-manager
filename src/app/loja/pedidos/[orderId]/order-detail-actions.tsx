'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  cancelStoreOrderAction,
  confirmStoreOrderPaymentAction,
  deliverStoreOrderItemAction,
  undoStoreOrderItemDeliveryAction,
} from '../../actions';
import { ReasonDialog } from '@/app/operacoes/components/ReasonDialog';
import { isSyntheticGatewayPayload } from '@/lib/payments/synthetic-gateway-payload';
import { DeliverProductConfirmDialog } from '@/components/product-pickup/DeliverProductConfirmDialog';

export function OrderPaymentActions({
  storeOrderId,
  status,
  gatewayPaymentId,
}: {
  storeOrderId: string;
  status: string;
  gatewayPaymentId?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const syntheticCharge = isSyntheticGatewayPayload({ gatewayPaymentId });
  const hasGatewayCharge = Boolean(gatewayPaymentId) && !syntheticCharge;
  const canConfirm = status === 'pending' && !hasGatewayCharge && !syntheticCharge;
  const canCancelLocalCharge = (status === 'pending' || status === 'confirmed') && !hasGatewayCharge;

  if (!canConfirm && !canCancelLocalCharge && !hasGatewayCharge) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canConfirm ? (
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
      ) : null}
      {canCancelLocalCharge ? (
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
      ) : null}
      {hasGatewayCharge && status !== 'cancelled' ? (
        <p className="text-xs text-amber-200">
          Esta cobrança passou por gateway. O cancelamento operacional do item não estorna o pagamento — trate o financeiro no registro correspondente.
        </p>
      ) : null}
      {message ? <p className="text-xs text-slate-400" role="status">{message}</p> : null}
    </div>
  );
}

export function OrderItemActions({
  storeOrderId,
  itemId,
  status,
  hasQr,
  productName,
  quantity,
  orderReference,
  customerName,
  canDeliver = true,
  canViewQr = true,
}: {
  storeOrderId: string;
  itemId: string;
  status: string;
  hasQr: boolean;
  productName: string;
  quantity: number;
  orderReference: string;
  customerName?: string | null;
  canDeliver?: boolean;
  canViewQr?: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [showUndoReason, setShowUndoReason] = useState(false);
  const [showDeliverConfirm, setShowDeliverConfirm] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasQr && canViewQr && (status === 'confirmed' || status === 'delivered') ? (
        <Link
          href={`/produto/retirada/loja/${storeOrderId}/${itemId}`}
          className="inline-flex h-8 items-center rounded-lg border border-cyan-500/40 px-2 text-[11px] text-cyan-200"
        >
          Ver QR
        </Link>
      ) : null}
      {canDeliver && status === 'confirmed' ? (
        <button
          type="button"
          onClick={() => setShowDeliverConfirm(true)}
          className="inline-flex h-8 items-center rounded-lg border border-emerald-500/40 px-2 text-[11px] text-emerald-200 disabled:opacity-50"
        >
          Marcar como entregue
        </button>
      ) : null}
      {canDeliver && status === 'delivered' ? (
        <button
          type="button"
          onClick={() => setShowUndoReason(true)}
          className="inline-flex h-8 items-center rounded-lg border border-slate-700 px-2 text-[11px] text-slate-300 disabled:opacity-50"
        >
          Desfazer entrega
        </button>
      ) : null}
      {message ? <p className="text-xs text-slate-400" role="status">{message}</p> : null}
      {showDeliverConfirm ? (
        <DeliverProductConfirmDialog
          productName={productName}
          quantity={quantity}
          orderReference={orderReference}
          customerName={customerName}
          onCancel={() => setShowDeliverConfirm(false)}
          onConfirm={async () => {
            const response = await deliverStoreOrderItemAction(itemId);
            setMessage(response.message);
            if (response.success) router.refresh();
            return response;
          }}
        />
      ) : null}
      {showUndoReason ? (
        <ReasonDialog
          title="Desfazer entrega do item"
          description="O item volta ao estoque e passa a poder ser entregue novamente."
          submitLabel="Desfazer entrega"
          onSubmit={async ({ reasonCode, reasonText }) => {
            const response = await undoStoreOrderItemDeliveryAction(itemId, reasonCode, reasonText);
            setMessage(response.message);
            if (response.success) router.refresh();
            return response;
          }}
          onClose={() => setShowUndoReason(false)}
        />
      ) : null}
    </div>
  );
}
