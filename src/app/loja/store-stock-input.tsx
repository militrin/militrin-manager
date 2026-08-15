"use client";

import { useState, useTransition } from "react";
import { setStoreItemStockAction } from "./actions";

export function StoreStockInput({ storeItemId, variantId, totalQuantity, reservedQuantity, deliveredQuantity, availableQuantity }: {
  storeItemId: string;
  variantId: string | null;
  totalQuantity: number;
  reservedQuantity: number;
  deliveredQuantity: number;
  availableQuantity: number;
}) {
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(String(totalQuantity));
  const [message, setMessage] = useState<string | null>(null);
  const dirty = value !== String(totalQuantity);

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
      <span>Reservado: {reservedQuantity}</span>
      <span>Entregue: {deliveredQuantity}</span>
      <span className="text-emerald-300">Disponível: {availableQuantity}</span>
      <span className="ml-2 flex items-center gap-1">
        Total:
        <input
          type="number" min="0" value={value} onChange={(e) => { setValue(e.target.value); setMessage(null); }}
          className="h-7 w-16 rounded-lg border border-slate-700 bg-slate-950 px-2 text-[11px] text-slate-100"
        />
        <button
          type="button" disabled={pending || !dirty}
          onClick={() => startTransition(async () => {
            const result = await setStoreItemStockAction({ storeItemId, variantId, totalQuantity: Number(value) || 0 });
            setMessage(result.message);
          })}
          className="h-7 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2 text-[11px] text-emerald-200 disabled:opacity-50"
        >
          {pending ? "..." : "Salvar"}
        </button>
      </span>
      {message ? <span role="status">{message}</span> : null}
    </div>
  );
}
