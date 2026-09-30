import { PRODUCT_PICKUP_PASS_COPY, type ProductPickupPassData } from '@/lib/product-pickup/product-pickup-pass';
import { cx } from '@/components/militrin';

function BagMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M6 8h12l-.7 11.2a2 2 0 0 1-2 1.8H8.7a2 2 0 0 1-2-1.8L6 8Z" />
      <path d="M9 8V6.8A3 3 0 0 1 12 4a3 3 0 0 1 3 2.8V8" />
    </svg>
  );
}

export function ProductPickupPass({ pass }: { pass: ProductPickupPassData }) {
  const delivered = pass.status === 'delivered';
  const pending = pass.status === 'confirmed';
  const statusTone = delivered
    ? 'border-emerald-400/45 bg-emerald-500/15 text-emerald-50'
    : pending
      ? 'border-amber-400/40 bg-amber-500/12 text-amber-50'
      : 'border-slate-600/50 bg-slate-900/80 text-slate-200';
  const qrs = pass.qrs.length > 0 ? pass.qrs : [{ unitLabel: null, qrDataUrl: null, qrPreview: null, alt: PRODUCT_PICKUP_PASS_COPY.qrImageAlt }];

  return (
    <article className="relative overflow-hidden rounded-[1.75rem] border border-teal-400/25 bg-[#06111c] text-white shadow-[0_24px_60px_rgba(0,0,0,0.45)]">
      <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-1.5 bg-gradient-to-b from-teal-300 via-emerald-400 to-teal-700" />
      <div aria-hidden className="pointer-events-none absolute -right-16 top-10 h-40 w-40 rounded-full bg-teal-400/10 blur-3xl" />

      <div className="relative px-5 pb-6 pt-5 sm:px-6">
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-teal-200/90">{PRODUCT_PICKUP_PASS_COPY.brand}</p>
            <p className="mt-1 text-sm font-semibold uppercase tracking-[0.18em] text-white">{PRODUCT_PICKUP_PASS_COPY.title}</p>
          </div>
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-teal-400/30 bg-teal-500/10 text-teal-200">
            <BagMark className="h-5 w-5" />
          </div>
        </header>

        <h1 className="mt-6 text-[1.65rem] font-semibold leading-tight tracking-tight">{pass.productName}</h1>
        <p className="mt-1 text-sm text-teal-100/80">{pass.quantityLabel}</p>

        <div className="mt-5 space-y-4">
          {qrs.map((qr, index) => (
            <div key={qr.unitLabel ?? index} className="space-y-3">
              {qr.unitLabel ? <p className="text-center text-xs font-semibold uppercase tracking-[0.16em] text-teal-200/80">{qr.unitLabel}</p> : null}
              <div className="mx-auto w-full max-w-[320px] rounded-[1.4rem] bg-white p-4">
                {qr.qrDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qr.qrDataUrl} alt={qr.alt} className="mx-auto aspect-square h-auto w-full bg-white" />
                ) : (
                  <p className="flex min-h-[220px] items-center justify-center px-3 text-center text-sm text-slate-600">
                    {pass.instruction}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        <dl className="mt-5 space-y-2 text-center">
          <div>
            <dt className="sr-only">{PRODUCT_PICKUP_PASS_COPY.orderLabel}</dt>
            <dd className="text-lg font-semibold tabular-nums tracking-tight">{PRODUCT_PICKUP_PASS_COPY.orderLabel} {pass.orderLabel}</dd>
          </div>
          {qrs.some((qr) => qr.qrPreview) ? (
            <div>
              <dt className="sr-only">{PRODUCT_PICKUP_PASS_COPY.codeLabel}</dt>
              <dd className="font-mono text-xs tracking-wide text-slate-400">
                {PRODUCT_PICKUP_PASS_COPY.codeLabel} {qrs.map((qr) => qr.qrPreview).filter(Boolean).join(' · ')}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className={cx('mt-5 rounded-2xl border px-4 py-3 text-center', statusTone)}>
          <p className="text-sm font-semibold uppercase tracking-[0.16em]">
            <span aria-hidden className="mr-2 inline-block h-2 w-2 rounded-full bg-current" />
            {delivered ? PRODUCT_PICKUP_PASS_COPY.delivered : pass.statusLabel}
          </p>
          {delivered && pass.deliveredAtLabel ? (
            <p className="mt-1 text-xs text-emerald-100/80">{pass.deliveredAtLabel}</p>
          ) : null}
        </div>

        <p className="mt-4 text-center text-xs leading-relaxed text-slate-400">{pass.instruction}</p>
      </div>
    </article>
  );
}
