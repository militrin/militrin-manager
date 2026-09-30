'use client';

import Link from 'next/link';
import { DeliverProductButton } from '@/components/product-pickup/DeliverProductConfirmDialog';
import { additionalItemStatusLabel, canDeliverProductLine, type AdditionalItemStatus } from '@/lib/operations/additional-product-items';

export function OrderProductItemCard({
  itemId,
  name,
  variantText,
  quantity,
  amountLabel,
  status,
  pickupQrMode,
  pickupHref,
  canViewQr,
  canDeliver,
  orderReference,
  customerName,
}: {
  itemId: string;
  name: string;
  variantText: string | null;
  quantity: number;
  amountLabel: string;
  status: AdditionalItemStatus;
  pickupQrMode: string | null;
  pickupHref: string | null;
  canViewQr: boolean;
  canDeliver: boolean;
  orderReference: string;
  customerName: string | null;
}) {
  const deliveryLabel = additionalItemStatusLabel(status);
  const deliveryClass =
    status === 'delivered'
      ? 'border-emerald-500/40 text-emerald-200'
      : status === 'cancelled'
        ? 'border-slate-700 text-slate-400'
        : status === 'confirmed'
          ? 'border-amber-500/40 text-amber-200'
          : 'border-slate-700 text-slate-400';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-slate-100">{quantity}x {name}</p>
          <p className="text-xs text-slate-400">{variantText ?? 'Sem variante'}</p>
          {amountLabel ? <p className="mt-0.5 text-xs text-slate-500">{amountLabel}</p> : null}
        </div>
        <span className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${deliveryClass}`}>{deliveryLabel}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {pickupHref && canViewQr ? (
          <Link href={pickupHref} className="rounded-lg border border-cyan-500/40 px-3 py-1.5 text-xs font-semibold text-cyan-200">
            Ver QR
          </Link>
        ) : null}
        {canDeliver && canDeliverProductLine({ status, pickupQrMode }) ? (
          <DeliverProductButton
            source="checkout"
            itemId={itemId}
            productName={name}
            quantity={quantity}
            orderReference={orderReference}
            customerName={customerName}
          />
        ) : null}
      </div>
    </div>
  );
}
