"use client";

import { useState, useTransition } from "react";
import { setEventKitItemChangeRulesAction, setEventParticipantItemChangesAction } from "@/app/eventos/actions";

type ItemRule = { id: string; name: string; requires_variant: boolean; allow_participant_change: boolean; track_variant_inventory: boolean };

export function ItemChangeRules({ eventId, initialEnabled, items }: { eventId: string; initialEnabled: boolean; items: ItemRule[] }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [rules, setRules] = useState(items);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function saveGeneral() { startTransition(async () => { const result = await setEventParticipantItemChangesAction(eventId, enabled); setMessage(result.message); }); }
  function saveItem(item: ItemRule) { startTransition(async () => { const result = await setEventKitItemChangeRulesAction(item.id, item.allow_participant_change, item.track_variant_inventory); setMessage(result.message); }); }
  function update(id: string, values: Partial<ItemRule>) { setRules((current) => current.map((item) => item.id === id ? { ...item, ...values } : item)); }

  return <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
    <h3 className="font-semibold text-slate-100">Regras de alteração de itens de kit</h3>
    <label className="flex gap-2"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Permitir alteração de itens pelo participante</label>
    <button type="button" onClick={saveGeneral} disabled={pending} className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200">Salvar regra geral</button>
    <div className="grid gap-2 border-t border-slate-800 pt-3">
      {rules.map((item) => <div key={item.id} className="rounded-xl border border-slate-800 p-3">
        <p className="font-medium text-slate-100">{item.name}</p>
        {item.requires_variant ? <div className="mt-2 flex flex-wrap gap-4">
          <label><input type="checkbox" checked={item.allow_participant_change} onChange={(event) => update(item.id, { allow_participant_change: event.target.checked })} /> Alteração permitida</label>
          <label><input type="checkbox" checked={item.track_variant_inventory} onChange={(event) => update(item.id, { track_variant_inventory: event.target.checked })} /> Controlar estoque por opção</label>
          <button type="button" onClick={() => saveItem(item)} disabled={pending} className="rounded-lg border border-slate-700 px-2 py-1 text-xs">Salvar item</button>
        </div> : <p className="mt-1 text-xs text-slate-500">Opção única · não possui variante alterável.</p>}
      </div>)}
    </div>
    {message ? <p className="text-xs text-slate-400">{message}</p> : null}
  </div>;
}
