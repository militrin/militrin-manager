import type { ReactNode } from 'react';
import { cx } from './utils';

type MilitrinStatProps = {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
  className?: string;
};

export function MilitrinStat({ label, value, hint, icon, className }: MilitrinStatProps) {
  return (
    <div className={cx('rounded-2xl border border-white/10 bg-slate-950/50 p-4', className)}>
      <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-slate-400">{icon}{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </div>
  );
}
