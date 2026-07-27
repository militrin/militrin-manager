import type { ReactNode } from 'react';

type AdminSectionProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function AdminSection({ title, description, actions, children }: AdminSectionProps) {
  return (
    <section className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-black/15">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          {description ? <p className="mt-1 text-sm text-slate-300">{description}</p> : null}
        </div>
        {actions}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
