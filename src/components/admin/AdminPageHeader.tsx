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
};

export function AdminPageHeader({ title, subtitle, actions, breadcrumbs, backHref, fallbackHref }: AdminPageHeaderProps) {
  return (
    <header className="space-y-4 rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 shadow-lg shadow-black/15">
      {breadcrumbs ? <AppBreadcrumb items={breadcrumbs} backHref={backHref} fallbackHref={fallbackHref}/> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-white sm:text-3xl">{title}</h1>
          {subtitle ? <p className="mt-2 text-sm text-slate-300">{subtitle}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <PanelUserBadge />
        </div>
      </div>
    </header>
  );
}
