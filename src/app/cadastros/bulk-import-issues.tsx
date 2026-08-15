"use client";

import { useMemo, useState, useTransition } from "react";
import { bulkResolveImportCategoryBatchAction } from "./actions";

type Option = { id: string; name: string };
export function BulkImportIssues({ importBatchId, candidates, categories, batches, prices }: { importBatchId: string; candidates: Array<{ id: string; name: string }>; categories: Option[]; batches: Option[]; prices: Array<{ batch_id: string; ticket_category_id: string }> }) {
  const [selected, setSelected] = useState(() => new Set(candidates.map((item) => item.id)));
  const [categoryId, setCategoryId] = useState(""); const [batchId, setBatchId] = useState("");
  const [message, setMessage] = useState<string | null>(null); const [pending, startTransition] = useTransition();
  const compatibleCategories = useMemo(() => batchId ? categories.filter((item) => prices.some((price) => price.batch_id === batchId && price.ticket_category_id === item.id)) : categories, [batchId,categories,prices]);
  const compatibleBatches = useMemo(() => categoryId ? batches.filter((item) => prices.some((price) => price.ticket_category_id === categoryId && price.batch_id === item.id)) : batches, [categoryId,batches,prices]);
  if (!candidates.length) return null;
  const categoryName = categories.find((item) => item.id === categoryId)?.name; const batchName = batches.find((item) => item.id === batchId)?.name;
  function apply() {
    if (!categoryId || !batchId || !selected.size) { setMessage("Selecione categoria, lote e ao menos um cadastro."); return; }
    if (!window.confirm(`Aplicar ${categoryName} / ${batchName} a ${selected.size} cadastros?`)) return;
    startTransition(async () => { const result = await bulkResolveImportCategoryBatchAction({ importBatchId, participantIds: [...selected], categoryId, batchId }); setMessage(result.message); });
  }
  return <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4"><h2 className="font-semibold text-amber-100">Resolver categoria e lote em massa</h2><p className="mt-1 text-sm text-amber-200">{candidates.length} cadastro(s) deste lote possuem pendência relacionada.</p><div className="mt-3 flex flex-wrap items-center gap-2"><select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className="min-w-48 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="">Selecionar categoria</option>{compatibleCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><select value={batchId} onChange={(event) => setBatchId(event.target.value)} className="min-w-48 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="">Selecionar lote</option>{compatibleBatches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" onClick={apply} disabled={pending} className="inline-flex h-10 shrink-0 items-center whitespace-nowrap rounded-xl bg-amber-400 px-4 font-semibold text-amber-950 disabled:opacity-50">{pending ? "Reavaliando..." : `Aplicar a ${selected.size} selecionado(s)`}</button></div><details className="mt-3"><summary className="cursor-pointer text-sm text-slate-200">Escolher registros individualmente</summary><div className="mt-2 grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">{candidates.map((item) => <label key={item.id} className="flex gap-2 text-sm"><input type="checkbox" checked={selected.has(item.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; })}/><span className="truncate">{item.name}</span></label>)}</div></details>{message ? <p className="mt-3 text-sm text-slate-200" role="status">{message}</p> : null}</section>;
}
