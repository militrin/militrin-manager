"use client";

import { ComparisonExportButtons } from "./comparison-export-buttons";

type EventOption = { id: string; name: string };
export function ComparisonEventSelector({ events, selectedIds }: { events: EventOption[]; selectedIds: string[] }) {
  return <div className="mb-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold">Comparativos guardados</p><p className="mt-1 text-xs text-slate-400">{selectedIds.length} evento(s) disponível(is); {events.length} no catálogo.</p></div><ComparisonExportButtons/></div>
  </div>;
}
