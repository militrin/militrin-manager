'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { cx } from '@/components/militrin';

type Kind = 'all' | 'ticket' | 'store';

const PurchaseKindContext = createContext<Kind>('all');

export function PurchaseKindFilter({
  ticketCount,
  storeCount,
  children,
}: {
  ticketCount: number;
  storeCount: number;
  children: ReactNode;
}) {
  const [kind, setKind] = useState<Kind>('all');
  const tabs = useMemo(
    () => [
      { id: 'all' as const, label: `Todos (${ticketCount + storeCount})` },
      { id: 'ticket' as const, label: `Ingressos (${ticketCount})` },
      { id: 'store' as const, label: `Loja (${storeCount})` },
    ],
    [ticketCount, storeCount],
  );

  return (
    <PurchaseKindContext.Provider value={kind}>
      <div className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setKind(tab.id)}
            className={cx(
              'rounded-full border px-3 py-1.5 text-xs font-semibold transition',
              kind === tab.id
                ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-100'
                : 'border-slate-700 bg-slate-950/70 text-slate-300 hover:border-slate-500',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="mt-4">{children}</div>
    </PurchaseKindContext.Provider>
  );
}

export function PurchaseKindItem({
  kind,
  children,
}: {
  kind: 'ticket' | 'store';
  children: ReactNode;
}) {
  const filter = useContext(PurchaseKindContext);
  if (filter !== 'all' && filter !== kind) return null;
  return children;
}
