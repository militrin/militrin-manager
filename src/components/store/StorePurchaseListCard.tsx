import Link from 'next/link';
import { Shirt } from 'lucide-react';
import { MilitrinLinkButton, MilitrinStatusBadge, cx, militrinTokens } from '@/components/militrin';
import { paymentStatusChip } from '@/components/militrin/status-chips';
import { formatStoreVariantLabel } from '@/lib/operations/store-order-scan-ref';
import { accountStoreItemHref, accountStoreOrderHref } from '@/lib/store/get-account-store-orders';
import { formatStoreQuantityLabel, pickStoreProductImageUrl, resolveStorePickupStatus } from '@/lib/store/store-pickup-pass';
import { formatDateLongBR } from '@/lib/utils/date';

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

type StoreListItem = {
  id: string;
  name: string;
  variantLabel: string | null;
  quantityLabel: string;
  imageUrl: string | null;
  pickupStatus: ReturnType<typeof resolveStorePickupStatus>;
};

export function summarizeStoreOrderItems(items: Array<Record<string, unknown>>): StoreListItem[] {
  return items.map((item) => {
    const storeItem = one(item.store_items as Record<string, unknown> | Record<string, unknown>[] | null);
    const variant = one(item.store_item_variants as Record<string, unknown> | Record<string, unknown>[] | null);
    const images = Array.isArray(storeItem?.store_item_images)
      ? (storeItem?.store_item_images as Array<Record<string, unknown>>)
      : [];
    return {
      id: String(item.id),
      name: String(storeItem?.name ?? 'Item'),
      variantLabel: formatStoreVariantLabel(variant as { name?: string; value?: string } | null),
      quantityLabel: formatStoreQuantityLabel(Number(item.quantity ?? 1)),
      imageUrl: pickStoreProductImageUrl(images),
      pickupStatus: resolveStorePickupStatus({
        itemStatus: String(item.status ?? ''),
        deliveredAt: item.delivered_at ? String(item.delivered_at) : null,
        pickupQrMode: item.pickup_qr_mode ? String(item.pickup_qr_mode) : null,
      }),
    };
  });
}

function ProductThumb({ src, name }: { src: string | null; name: string }) {
  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-800 bg-slate-950/80 sm:h-[4.5rem] sm:w-[4.5rem]">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={name} className="h-full w-full object-contain p-1" />
      ) : (
        <Shirt size={22} className="text-emerald-300/80" />
      )}
    </div>
  );
}

export function StorePurchaseListCard({
  orderId,
  orderNumber,
  commercialStatus,
  paymentStatus,
  createdAt,
  items,
  canContinuePayment,
}: {
  orderId: string;
  orderNumber: string;
  commercialStatus: string;
  paymentStatus: string;
  createdAt: string;
  items: StoreListItem[];
  canContinuePayment: boolean;
}) {
  const chip = paymentStatusChip(paymentStatus);
  const first = items[0] ?? null;
  const href = items.length === 1 ? accountStoreItemHref(orderId, items[0].id) : accountStoreOrderHref(orderId);
  const ctaLabel = canContinuePayment ? 'Continuar pagamento' : items.length === 1 ? 'Ver item' : 'Ver itens';

  return (
    <article className={cx(militrinTokens.radiusMd, militrinTokens.surfaceMuted, militrinTokens.shadow, 'overflow-hidden')}>
      <div className="flex gap-3 p-3.5 sm:p-4">
        <ProductThumb src={first?.imageUrl ?? null} name={first?.name ?? 'Produto'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Pedido {orderNumber}</p>
            <MilitrinStatusBadge status={commercialStatus} />
          </div>
          <p className="mt-1 truncate text-sm font-semibold text-white" title={first?.name}>
            {items.length === 1 ? first?.name : `${items.length} itens da Loja`}
          </p>
          {items.length === 1 ? (
            <p className="mt-0.5 text-xs text-slate-400">
              {[first?.variantLabel, first?.quantityLabel].filter(Boolean).join(' · ')}
            </p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-400">
              {items.slice(0, 3).map((item) => (
                <li key={item.id} className="truncate">
                  {item.name}
                  {item.variantLabel ? ` · ${item.variantLabel}` : ''} · {item.quantityLabel}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-200">
              <chip.icon size={11} />
              {chip.label}
            </span>
            {first?.pickupStatus === 'delivered' && items.length === 1 ? (
              <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-200">
                Item retirado
              </span>
            ) : null}
            <span className="text-[11px] text-slate-500">Pedido em {formatDateLongBR(createdAt)}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2 border-t border-slate-800/80 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-end sm:gap-3 sm:px-4">
        {items.length > 1 && !canContinuePayment ? (
          <div className="flex min-w-0 flex-1 flex-wrap gap-2 sm:justify-start">
            {items.map((item) => (
              <Link
                key={item.id}
                href={accountStoreItemHref(orderId, item.id)}
                className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/20"
              >
                Ver QR · {item.name}
              </Link>
            ))}
          </div>
        ) : null}
        <MilitrinLinkButton
          href={canContinuePayment ? accountStoreOrderHref(orderId) : href}
          variant={canContinuePayment ? 'warning' : 'success'}
          size="sm"
          className="w-full sm:w-auto"
        >
          {ctaLabel}
        </MilitrinLinkButton>
      </div>
    </article>
  );
}
