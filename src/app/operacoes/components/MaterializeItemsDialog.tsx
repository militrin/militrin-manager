"use client";

import { useState, useTransition } from "react";
import {
  getKitMaterializationPreviewAction,
  materializeEventParticipantKitItemsAction,
  materializeParticipantKitItemsAction,
} from "../actions";

type Preview = {
  participantName: string;
  ticketLabel: string;
  categoryName: string;
  items: Array<{
    id: string;
    name: string;
    itemType: string;
    quantity: number;
    state: string;
    variation: string | null;
    message: string | null;
  }>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function MaterializeItemsDialog({ ticketId, onSuccess }: { ticketId: string; onSuccess: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function load() {
    if (!UUID_PATTERN.test(ticketId)) { setMessage("Identificador de ingresso inválido."); return; }
    setOpen(true); setMessage(null); setPreview(null);
    startTransition(async () => {
      const result = await getKitMaterializationPreviewAction(ticketId);
      if (!result.success) setMessage(result.message);
      else setPreview(result.preview as Preview);
    });
  }

  function confirm() {
    if (!UUID_PATTERN.test(ticketId)) { setMessage("Identificador de ingresso inválido."); return; }
    startTransition(async () => {
      const result = await materializeParticipantKitItemsAction(ticketId);
      setMessage(result.message);
      if (result.success) await onSuccess();
    });
  }

  return <>
    <button type="button" onClick={load} className="rounded-lg border border-amber-500/40 px-2 py-1 text-[11px] font-semibold text-amber-200">Vincular itens</button>
    {open ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-lg rounded-3xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <h2 className="text-lg font-semibold">Vincular itens aplicáveis</h2>
        {preview ? <div className="mt-3 space-y-3 text-sm">
          <p><b>{preview.participantName}</b> · ingresso {preview.ticketLabel} · {preview.categoryName}</p>
          <div className="space-y-2">{preview.items.map((item) => <div key={item.id} className="rounded-xl border border-slate-700 p-3">
            <div className="flex justify-between gap-3"><span>{item.name} × {item.quantity}</span><span>{item.state === "existing" ? "Já vinculado" : item.state === "missing" ? "Será criado" : "Pendente"}</span></div>
            {item.variation ? <p className="text-xs text-slate-400">Variação: {item.variation}</p> : null}
            {item.message ? <p className="text-xs text-amber-300">{item.message}</p> : null}
          </div>)}</div>
        </div> : null}
        {message ? <p className="mt-3 text-sm text-amber-200">{message}</p> : null}
        <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-slate-700 px-4 py-2">Cancelar</button><button type="button" disabled={pending || !preview} onClick={confirm} className="rounded-xl bg-emerald-500 px-4 py-2 font-semibold text-slate-950 disabled:opacity-40">Confirmar vínculo</button></div>
      </div>
    </div> : null}
  </>;
}

export function BatchMaterializeItemsDialog({ eventId, count, onSuccess }: { eventId: string; count: number; onSuccess: () => Promise<void> }) {
  const [open, setOpen] = useState(false); const [message, setMessage] = useState<string | null>(null); const [pending, startTransition] = useTransition();
  function confirm() { startTransition(async () => { const result = await materializeEventParticipantKitItemsAction(eventId); if (result.success) { const summary = result.result; setMessage(`Criados: ${Number(summary.created_count ?? 0)} · existentes: ${Number(summary.existing_count ?? 0)} · ignorados: ${Number(summary.skipped_count ?? 0)}`); await onSuccess(); } else setMessage(result.message); }); }
  return <><button type="button" onClick={() => setOpen(true)} className="rounded-xl border border-amber-500/40 px-3 py-2 text-sm font-semibold text-amber-200">Regularizar itens pendentes ({count})</button>{open ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" role="dialog" aria-modal="true"><div className="w-full max-w-md rounded-3xl border border-slate-700 bg-slate-900 p-6"><h2 className="text-lg font-semibold">Regularizar itens do evento</h2><p className="mt-2 text-sm text-slate-300">{count} participante(s) com configuração pendente serão processados. Itens já vinculados serão preservados e registros incompletos serão ignorados.</p>{message ? <p className="mt-3 text-sm text-amber-200">{message}</p> : null}<div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-slate-700 px-4 py-2">Cancelar</button><button type="button" disabled={pending} onClick={confirm} className="rounded-xl bg-emerald-500 px-4 py-2 font-semibold text-slate-950 disabled:opacity-40">Confirmar regularização</button></div></div></div> : null}</>;
}
