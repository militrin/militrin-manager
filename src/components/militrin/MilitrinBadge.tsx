import type { HTMLAttributes } from 'react';
import { cx } from './utils';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

const toneClass: Record<Tone, string> = {
  neutral: 'border-slate-600/60 bg-slate-800/40 text-slate-200',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  danger: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
  info: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
};

type MilitrinBadgeProps = HTMLAttributes<HTMLSpanElement> & { tone?: Tone };

export function MilitrinBadge({ className, children, tone = 'neutral', ...props }: MilitrinBadgeProps) {
  return (
    <span {...props} className={cx('rounded-full border px-3 py-1 text-xs uppercase tracking-wide', toneClass[tone], className)}>
      {children}
    </span>
  );
}
