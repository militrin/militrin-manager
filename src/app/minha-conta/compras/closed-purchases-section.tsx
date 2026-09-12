'use client';

import { useState, type ReactNode } from 'react';
import { cx, militrinType } from '@/components/militrin';

export function ClosedPurchasesSection({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (count <= 0) return null;

  return (
    <section className="mt-6 border-t border-slate-800/80 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className={militrinType.sectionTitle}>Compras encerradas ({count})</h3>
          <p className={cx('mt-0.5', militrinType.bodyMuted)}>
            Canceladas, expiradas e tentativas que já não podem ser pagas. O histórico não é apagado.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          className="rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2 text-xs font-semibold text-slate-200 hover:border-slate-500"
        >
          {open ? 'Ocultar compras encerradas' : 'Mostrar compras encerradas'}
        </button>
      </div>
      {open ? <div className="mt-4 space-y-3">{children}</div> : null}
    </section>
  );
}
