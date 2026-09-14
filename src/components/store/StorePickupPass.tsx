import type { ReactNode } from 'react';
import { STORE_PICKUP_PASS_COPY, type StorePickupPassData } from '@/lib/store/store-pickup-pass';
import { cx } from '@/components/militrin';

function ShirtMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M8 7 4.5 5.5 3 8.5 8 12v8h8v-8l5-3.5-1.5-3L16 7V4H8v3Z" />
    </svg>
  );
}

function StoreProductVisual({ pass, className }: { pass: StorePickupPassData; className?: string }) {
  if (pass.productImageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={pass.productImageUrl}
        alt={pass.productName}
        className={cx('h-full w-full object-contain', className)}
      />
    );
  }

  return (
    <div className={cx('flex h-full w-full flex-col items-center justify-center gap-2 text-emerald-200/80', className)}>
      <ShirtMark className="h-10 w-10" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.22em]">Loja</span>
    </div>
  );
}

export function StorePickupPass({
  pass,
  qrDataUrl = null,
  actions,
}: {
  pass: StorePickupPassData;
  qrDataUrl?: string | null;
  actions?: ReactNode;
}) {
  const pickupTone =
    pass.pickupStatus === 'delivered'
      ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100'
      : pass.pickupStatus === 'pending'
        ? 'border-amber-400/40 bg-amber-500/12 text-amber-100'
        : 'border-slate-600/50 bg-slate-900/70 text-slate-200';

  return (
    <article className="relative overflow-hidden rounded-[1.75rem] border border-emerald-500/20 bg-[#07130f] text-zinc-100 shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_rgba(16,185,129,0.22),_transparent_58%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-10 top-24 h-48 w-48 rotate-12 rounded-full bg-emerald-400/10 blur-3xl"
      />

      <div className="relative px-5 pb-5 pt-5 sm:px-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="text-lg font-semibold tracking-tight text-white">{STORE_PICKUP_PASS_COPY.brand}</p>
            {pass.eventName ? <p className="text-[10px] uppercase tracking-[0.22em] text-emerald-300/80">{pass.eventName}</p> : null}
          </div>
          <div className="flex items-center gap-2 rounded-2xl border border-emerald-400/25 bg-emerald-500/10 px-3 py-2 text-right">
            <ShirtMark className="h-4 w-4 text-emerald-300" />
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-200">{STORE_PICKUP_PASS_COPY.badgeTitle}</p>
              <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-300/80">{STORE_PICKUP_PASS_COPY.badgeSubtitle}</p>
            </div>
          </div>
        </header>

        <div className="mt-5 overflow-hidden rounded-[1.4rem] border border-white/8 bg-black/25 p-4">
          <div className="mx-auto h-40 w-full max-w-[220px] sm:h-60">
            <StoreProductVisual pass={pass} />
          </div>
        </div>

        <h2 className="mt-5 text-2xl font-semibold tracking-tight text-white">{pass.productName}</h2>
        {pass.unitLabel ? <p className="mt-1 text-sm text-emerald-200/80">{pass.unitLabel}</p> : null}

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{STORE_PICKUP_PASS_COPY.variantLabel}</p>
            <p className="mt-1 text-sm font-semibold text-emerald-100">{pass.variantLabel || STORE_PICKUP_PASS_COPY.noVariant}</p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{STORE_PICKUP_PASS_COPY.quantityLabel}</p>
            <p className="mt-1 text-sm font-semibold text-white">{pass.quantityLabel}</p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)] sm:items-center">
          <div className="mx-auto w-full max-w-[280px] rounded-[1.35rem] bg-white p-3 sm:mx-0">
            {pass.canShowQr && qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrDataUrl} alt={STORE_PICKUP_PASS_COPY.qrImageAlt} className="mx-auto h-52 w-52 bg-white sm:h-60 sm:w-60" />
            ) : (
              <p className="flex min-h-[180px] items-center justify-center px-4 text-center text-sm text-slate-600">
                {pass.pickupQrMode === 'none' ? STORE_PICKUP_PASS_COPY.instructionNone : STORE_PICKUP_PASS_COPY.qrUnavailable}
              </p>
            )}
          </div>

          <div className="space-y-3 text-sm">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{STORE_PICKUP_PASS_COPY.orderLabel}</p>
              <p className="mt-1 text-xl font-semibold tabular-nums text-white">{pass.orderNumber}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{STORE_PICKUP_PASS_COPY.orderDateLabel}</p>
              <p className="mt-1 text-slate-200">{pass.orderDateLabel}</p>
            </div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">Pagamento</p>
              <p className="mt-1 text-emerald-100">{pass.paymentStatusLabel}</p>
            </div>
          </div>
        </div>

        <div className={cx('mt-5 rounded-2xl border px-4 py-3 text-center', pickupTone)}>
          <p className="text-sm font-semibold uppercase tracking-[0.14em]">
            {pass.pickupStatus === 'delivered' ? `✓ ${pass.pickupStatusLabel}` : pass.pickupStatusLabel}
          </p>
          {pass.pickupStatus === 'delivered' && pass.deliveredAtLabel ? (
            <p className="mt-1 text-xs text-emerald-100/80">{pass.deliveredAtLabel}</p>
          ) : null}
        </div>

        <p className="mt-4 text-center text-xs leading-relaxed text-slate-400">{pass.instruction}</p>
      </div>

      {actions ? <div className="relative border-t border-white/8 px-5 py-4 sm:px-6">{actions}</div> : null}
    </article>
  );
}
