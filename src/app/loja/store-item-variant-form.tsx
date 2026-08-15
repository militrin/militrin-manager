"use client";

import { useState, useTransition } from "react";
import { upsertStoreItemVariantAction } from "./actions";

export function StoreItemVariantForm({ storeItemId }: { storeItemId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [priceAdjustment, setPriceAdjustment] = useState("0");
  const [message, setMessage] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex h-7 items-center rounded-lg border border-slate-700 px-2 text-[11px] text-slate-300">
        + Variante
      </button>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/60 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await upsertStoreItemVariantAction({
            id: null, storeItemId, name, value, priceAdjustment: Number(priceAdjustment) || 0, isActive: true, sortOrder: 0,
          });
          setMessage(result.message);
          if (result.success) { setName(""); setValue(""); setPriceAdjustment("0"); setOpen(false); }
        });
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (ex.: Tamanho)" required className="h-7 w-28 rounded-lg border border-slate-700 bg-slate-950 px-2 text-[11px] text-slate-100" />
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Valor (ex.: M)" required className="h-7 w-20 rounded-lg border border-slate-700 bg-slate-950 px-2 text-[11px] text-slate-100" />
      <input value={priceAdjustment} onChange={(e) => setPriceAdjustment(e.target.value)} type="number" step="0.01" placeholder="+/- R$" className="h-7 w-20 rounded-lg border border-slate-700 bg-slate-950 px-2 text-[11px] text-slate-100" />
      <button type="submit" disabled={pending} className="h-7 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 text-[11px] text-emerald-200 disabled:opacity-50">
        {pending ? "..." : "Salvar"}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="h-7 rounded-lg border border-slate-700 px-2 text-[11px] text-slate-300">Cancelar</button>
      {message ? <span className="text-[11px] text-slate-400" role="status">{message}</span> : null}
    </form>
  );
}
