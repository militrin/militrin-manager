"use client";

import {
  accountHealthFiltersForActor,
  accountHealthHref,
  ACCOUNT_HEALTH_FILTER_LABEL,
  parseAccountHealthFilter,
} from "@/lib/account/account-health";

export function AccountHealthFilters({
  state,
  q,
  pageSize,
  canViewOrphans = false,
}: {
  state: string;
  q: string;
  pageSize: number;
  canViewOrphans?: boolean;
}) {
  const current = parseAccountHealthFilter(state, canViewOrphans);
  const filters = accountHealthFiltersForActor(canViewOrphans);
  return (
    <form action="/cadastros/saude-contas" className="grid gap-3 md:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_8rem_auto]">
      <label className="grid gap-1">
        <span className="text-xs text-slate-400">Busca</span>
        <input name="q" defaultValue={q} placeholder="Nome, CPF ou e-mail" className="h-11 rounded-xl border border-slate-700 bg-slate-950 px-3" />
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-slate-400">Situação</span>
        <select name="estado" defaultValue={current} className="h-11 rounded-xl border border-slate-700 bg-slate-950 px-3">
          {filters.map((value) => (
            <option key={value} value={value}>{ACCOUNT_HEALTH_FILTER_LABEL[value]}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-slate-400">Por página</span>
        <select name="pageSize" defaultValue={String(pageSize)} className="h-11 rounded-xl border border-slate-700 bg-slate-950 px-3">
          <option value="25">25</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
      </label>
      <div className="flex items-end gap-2">
        <button className="inline-flex h-11 items-center justify-center rounded-xl border border-emerald-500/40 px-4 text-emerald-200">Filtrar</button>
        <a href={accountHealthHref({})} className="inline-flex h-11 items-center rounded-xl border border-slate-700 px-4 text-sm text-slate-300">Limpar</a>
      </div>
    </form>
  );
}
