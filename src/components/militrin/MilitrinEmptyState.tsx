import type { ReactNode } from 'react';
import { MilitrinButton } from './MilitrinButton';

type MilitrinEmptyStateProps = {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  actionHref?: string;
  extra?: ReactNode;
};

export function MilitrinEmptyState({ title, description, actionLabel, onAction, actionHref, extra }: MilitrinEmptyStateProps) {
  return (
    <div className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-6 text-center text-slate-300">
      <p className="text-lg font-semibold text-white">{title}</p>
      <p className="mt-2 text-sm text-slate-300">{description}</p>
      {actionLabel && onAction ? (
        <MilitrinButton className="mt-4" onClick={onAction}>{actionLabel}</MilitrinButton>
      ) : null}
      {actionLabel && actionHref ? (
        <a href={actionHref} className="mt-4 inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950">
          {actionLabel}
        </a>
      ) : null}
      {extra ? <div className="mt-3">{extra}</div> : null}
    </div>
  );
}
