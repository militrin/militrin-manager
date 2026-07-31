"use client";

import Link from "next/link";
import { Bell, Plus, Search } from "lucide-react";
import { PanelUserBadge } from "./PanelUserBadge";

export function TopBar({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <header className="flex flex-col gap-4 rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-black/10 lg:flex-row lg:items-center lg:justify-between">
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.28em] text-emerald-400">
          {subtitle}
        </p>
        <h1 className="text-2xl font-semibold text-white">{title}</h1>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="flex items-center gap-2 rounded-2xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm text-slate-400">
          <Search size={16} />
          <input
            className="w-full bg-transparent outline-none placeholder:text-slate-500 sm:w-56"
            placeholder="Buscar inscrição"
            aria-label="Buscar inscrição"
          />
        </label>

        <Link
          href="/inscricoes/nova"
          className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-4 py-2.5 font-medium text-emerald-950 transition hover:bg-emerald-400"
        >
          <Plus size={18} />
          Nova inscrição
        </Link>

        <div className="flex items-center gap-3">
          <button className="rounded-2xl border border-slate-800 p-2.5 text-slate-300 transition hover:bg-slate-800">
            <Bell size={18} />
          </button>
          <PanelUserBadge />
        </div>
      </div>
    </header>
  );
}
