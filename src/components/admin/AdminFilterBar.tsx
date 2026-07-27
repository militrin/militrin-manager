import type { ReactNode } from 'react';

export function AdminFilterBar({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">{children}</div>;
}
