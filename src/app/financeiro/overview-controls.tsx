"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

type EventOption={id:string;name:string};

export function FinancialOverviewControls({ events, selectedIds, dateFrom, dateTo }: { events:EventOption[]; selectedIds:string[]; dateFrom:string; dateTo:string }) {
  const pathname=usePathname(); const router=useRouter(); const searchParams=useSearchParams(); const [pending,startTransition]=useTransition();
  function navigate(mutator:(params:URLSearchParams)=>void) { if(pending)return; const params=new URLSearchParams(searchParams.toString()); mutator(params); params.set("tab","overview"); startTransition(()=>router.replace(`${pathname}?${params.toString()}`,{scroll:false})); }
  function setEvents(ids:string[]) { navigate((params)=>{params.delete("viewEvent"); for(const id of ids)params.append("viewEvent",id);}); }
  function toggleEvent(id:string) { setEvents(selectedIds.includes(id) ? selectedIds.filter((item)=>item!==id) : [...selectedIds,id]); }
  function setDate(name:"dateFrom"|"dateTo",value:string) { navigate((params)=>{if(value)params.set(name,value);else params.delete(name);}); }
  function saveComparison() { navigate((params)=>{const period=`${dateFrom||"*"}..${dateTo||"*"}`; const ids=(selectedIds.length?selectedIds:events.map((event)=>event.id)).slice().sort(); const key=`${ids.join(",")}|${period}`; const installed=new Set(params.getAll("compareRow")); if(ids.length>0&&!installed.has(key))params.append("compareRow",key);}); }
  return <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-4">
    <div className="grid gap-4 lg:grid-cols-[minmax(260px,1fr)_160px_160px_auto] lg:items-end">
      <div><p className="mb-1 text-sm font-medium">Eventos</p><details className="relative"><summary className="cursor-pointer list-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm">{selectedIds.length===0?"Todos os eventos":`${selectedIds.length} evento(s) selecionado(s)`}</summary><div className="absolute z-20 mt-2 max-h-80 w-full min-w-72 overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-3 shadow-2xl"><button type="button" onClick={()=>setEvents([])} className={`mb-2 w-full rounded-lg border px-3 py-2 text-left text-sm ${selectedIds.length===0?"border-emerald-400 text-emerald-200":"border-slate-700"}`}>Todos os eventos</button>{events.map((event)=><label key={event.id} className="flex cursor-pointer items-center gap-2 border-t border-slate-800 py-2 text-sm"><input type="checkbox" checked={selectedIds.includes(event.id)} onChange={()=>toggleEvent(event.id)} disabled={pending}/><span>{event.name}</span></label>)}</div></details></div>
      <label className="space-y-1 text-sm">De<input type="date" value={dateFrom} onChange={(event)=>setDate("dateFrom",event.target.value)} disabled={pending} className="block w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"/></label>
      <label className="space-y-1 text-sm">Até<input type="date" value={dateTo} onChange={(event)=>setDate("dateTo",event.target.value)} disabled={pending} className="block w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"/></label>
      <button type="button" onClick={saveComparison} disabled={pending} className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-60">Guardar no comparativo</button>
    </div><p aria-live="polite" className="mt-2 text-xs text-slate-400">{pending?"Atualizando informações…":"Eventos e datas atualizam o resumo automaticamente."}</p>
  </div>;
}
