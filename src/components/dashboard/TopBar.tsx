"use client";

import type { ReactNode } from "react";
import { Bell } from "lucide-react";
import { PanelUserBadge } from "./PanelUserBadge";
import { AppBreadcrumb } from "@/components/navigation/AppBreadcrumb";
import type { BreadcrumbItem } from "@/lib/navigation/admin-navigation";

export function TopBar({
  title,
  subtitle,
  breadcrumbs,
  backHref,
  fallbackHref,
  actions,
}: {
  title: string;
  subtitle: string;
  breadcrumbs?: BreadcrumbItem[];
  backHref?: string;
  fallbackHref?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="space-y-4 rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-black/10">
      <AppBreadcrumb items={breadcrumbs ?? [{label:"Início",href:"/painel"},{label:title}]} backHref={backHref} fallbackHref={fallbackHref}/>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.28em] text-emerald-400">
          {subtitle}
        </p>
        <h1 className="text-2xl font-semibold text-white">{title}</h1>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {actions}

        <div className="flex items-center gap-3">
          <button className="rounded-2xl border border-slate-800 p-2.5 text-slate-300 transition hover:bg-slate-800">
            <Bell size={18} />
          </button>
          <PanelUserBadge />
        </div>
      </div>
      </div>
    </header>
  );
}
