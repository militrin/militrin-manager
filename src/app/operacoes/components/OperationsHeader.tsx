"use client";

import { AppBreadcrumb } from "@/components/navigation/AppBreadcrumb";

export function OperationsHeader() {
  return (
    <header className="space-y-4 rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-black/10">
      <AppBreadcrumb items={[{label:"Início",href:"/painel"},{label:"Central de Operações"}]} backHref="/painel"/>
      <div>
        <p className="text-sm font-medium uppercase tracking-[0.28em] text-emerald-400">
          Operação em tempo real de credenciamento, kits, pulseiras e acesso
        </p>
        <h1 className="text-2xl font-semibold text-white">Central de Operações</h1>
      </div>
    </header>
  );
}
