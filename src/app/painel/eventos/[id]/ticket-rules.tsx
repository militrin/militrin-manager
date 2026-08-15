"use client";

import { useState, useTransition } from "react";
import { setEventTicketHolderRulesAction } from "@/app/eventos/actions";

export function TicketRules({ eventId, initialHolderChange, initialTicketTransfer }: { eventId: string; initialHolderChange: boolean; initialTicketTransfer: boolean }) {
  const [holderChange, setHolderChange] = useState(initialHolderChange);
  const [ticketTransfer, setTicketTransfer] = useState(initialTicketTransfer);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const result = await setEventTicketHolderRulesAction(eventId, holderChange, ticketTransfer);
      setMessage(result.message);
    });
  }

  return (
    <div className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
      <h3 className="font-semibold text-slate-100">Regras do ingresso</h3>
      <label className="flex gap-2"><input type="checkbox" checked={holderChange} onChange={(event) => setHolderChange(event.target.checked)} /> Permitir definição de titularidade</label>
      <label className="flex gap-2"><input type="checkbox" checked={ticketTransfer} onChange={(event) => setTicketTransfer(event.target.checked)} /> Permitir transferência de ingresso</label>
      <button type="button" onClick={save} disabled={pending} className="w-fit rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200">Salvar titularidade e transferência</button>
      {message ? <p className="text-xs text-slate-400">{message}</p> : null}
    </div>
  );
}
