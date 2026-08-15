import type { ReactNode } from 'react';
import { PanelUserBadge } from '@/components/dashboard/PanelUserBadge';
import { AppBreadcrumb } from '@/components/navigation/AppBreadcrumb';
import type { BreadcrumbItem } from '@/lib/navigation/admin-navigation';

type AdminPageHeaderProps = {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  breadcrumbs?: BreadcrumbItem[];
  backHref?: string;
  fallbackHref?: string;
  compact?: boolean;
};

export function AdminPageHeader({ title, subtitle, actions, breadcrumbs, backHref, fallbackHref, compact = false }: AdminPageHeaderProps) {
  return (
    <header className={`${compact ? 'space-y-2 rounded-2xl p-4' : 'space-y-4 rounded-3xl p-6'} border border-slate-800/80 bg-slate-900/70 shadow-lg shadow-black/15`}>
      {breadcrumbs ? <AppBreadcrumb items={breadcrumbs} backHref={backHref} fallbackHref={fallbackHref}/> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className={`${compact ? 'text-xl sm:text-2xl' : 'text-2xl sm:text-3xl'} font-semibold text-white`}>{title}</h1>
          {subtitle ? <p className={`${compact ? 'mt-1 text-xs' : 'mt-2 text-sm'} text-slate-300`}>{subtitle}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <PanelUserBadge />
        </div>
      </div>
    </header>
  );
}
