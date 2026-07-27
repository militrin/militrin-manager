import type { ReactNode } from 'react';
import { cx } from './utils';

type AdminStatCardProps = {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'success' | 'warning';
};

const toneClass: Record<NonNullable<AdminStatCardProps['tone']>, string> = {
  default: 'border-slate-800 bg-slate-950/60',
  success: 'border-emerald-500/30 bg-emerald-500/10',
  warning: 'border-amber-500/30 bg-amber-500/10',
};

export function AdminStatCard({ label, value, hint, tone = 'default' }: AdminStatCardProps) {
  return (
    <article className={cx('rounded-2xl border p-4', toneClass[tone])}>
      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-300">{hint}</p> : null}
    </article>
  );
}
