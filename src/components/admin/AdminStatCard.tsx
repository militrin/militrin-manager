import type { ReactNode } from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { cx } from './utils';

type AdminStatCardProps = {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  href?: string;
  actionLabel?: string;
  icon?: LucideIcon;
  compact?: boolean;
};

const toneClass: Record<NonNullable<AdminStatCardProps['tone']>, string> = {
  default: 'border-slate-800 bg-slate-950/60',
  success: 'border-emerald-500/30 bg-emerald-500/10',
  warning: 'border-amber-500/30 bg-amber-500/10',
  danger: 'border-rose-500/30 bg-rose-500/10',
  info: 'border-cyan-500/30 bg-cyan-500/10',
};

export function AdminStatCard({ label, value, hint, tone = 'default', href, actionLabel = 'Ver detalhes', icon: Icon, compact = false }: AdminStatCardProps) {
  const content = <>
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className={cx('font-medium text-slate-400', compact ? 'text-[11px] leading-4' : 'text-xs uppercase tracking-[0.2em]')}>{label}</p>
        <p className={cx('font-semibold text-white', compact ? 'mt-1 text-xl leading-7' : 'mt-2 text-2xl')}>{value}</p>
      </div>
      {Icon ? <span className={cx('shrink-0 border border-white/10 bg-white/5 text-slate-300', compact ? 'rounded-lg p-1.5' : 'rounded-xl p-2.5')}><Icon className={compact ? 'size-4' : 'size-5'} aria-hidden /></span> : null}
    </div>
    {hint ? <p className={cx('text-xs text-slate-300', compact ? 'mt-1.5 line-clamp-2 leading-4' : 'mt-2 leading-5')}>{hint}</p> : null}
    {href ? <span className={cx('inline-flex items-center gap-1 font-semibold text-emerald-300', compact ? 'mt-auto pt-2 text-[11px]' : 'mt-4 text-xs')}>{actionLabel}<span aria-hidden>→</span></span> : null}
  </>;
  const className = cx(
    'group rounded-2xl border shadow-sm transition duration-200',
    compact ? 'flex min-h-28 flex-col p-3' : 'p-4',
    toneClass[tone],
    href && 'cursor-pointer hover:-translate-y-0.5 hover:border-emerald-400/60 hover:bg-slate-900/90 hover:shadow-lg hover:shadow-emerald-950/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400',
  );
  return href ? <Link href={href} className={className}>{content}</Link> : <article className={className}>{content}</article>;
}
