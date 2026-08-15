import type { ReactNode } from 'react';

type AdminSectionProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  compact?: boolean;
};

export function AdminSection({ title, description, actions, children, compact = false }: AdminSectionProps) {
  return (
    <section className={`${compact ? 'rounded-2xl p-4' : 'rounded-3xl p-5'} border border-slate-800/80 bg-slate-900/70 shadow-lg shadow-black/15`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className={`${compact ? 'text-base' : 'text-lg'} font-semibold text-white`}>{title}</h2>
          {description ? <p className={`${compact ? 'mt-0.5 text-xs' : 'mt-1 text-sm'} text-slate-300`}>{description}</p> : null}
        </div>
        {actions}
      </div>
      <div className={compact ? 'mt-3' : 'mt-4'}>{children}</div>
    </section>
  );
}
