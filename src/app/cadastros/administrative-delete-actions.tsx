"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelCadastroAdditionalItemAction, cancelCadastroTicketAction } from "./actions";

function Dialog({ title, open, close, children }: { title: string; open: boolean; close: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={title}><div className="w-full max-w-lg rounded-3xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"><div className="flex items-center justify-between gap-3"><h3 className="text-lg font-semibold">{title}</h3><button type="button" onClick={close} aria-label="Fechar" className="text-slate-400 hover:text-white">×</button></div><div className="mt-4">{children}</div></div></div>;
}

const reasons = [
  ["incorrect_issue", "Emissão incorreta"], ["duplicate", "Duplicidade"], ["cancelled_order", "Pedido cancelado"],
  ["incorrect_registration", "Cadastro incorreto"], ["system_test", "Teste do sistema"],
  ["administrative_correction", "Correção administrativa"], ["other", "Outro"],
] as const;

function AdministrativeDeleteButton({ kind, contactId, entityId, details }: { kind: "ticket" | "item"; contactId: string; entityId: string; details: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false); const [reasonCode, setReasonCode] = useState(""); const [reasonText, setReasonText] = useState("");
  const [message, setMessage] = useState(""); const [pending, startTransition] = useTransition();
  function confirm() { startTransition(async () => {
    const payload = { contactId, reasonCode, reasonText };
    const result = kind === "ticket" ? await cancelCadastroTicketAction({ ...payload, ticketId: entityId }) : await cancelCadastroAdditionalItemAction({ ...payload, itemId: entityId });
    setMessage(result.message); if (result.success) { setOpen(false); router.refresh(); }
  }); }
  return <>
    <button type="button" onClick={() => { setMessage(""); setOpen(true); }} className="text-xs font-semibold text-red-300 hover:text-red-200">{kind === "ticket" ? "Excluir ingresso" : "Excluir item"}</button>
    <Dialog title={kind === "ticket" ? "Excluir ingresso?" : "Excluir item adicional?"} open={open} close={() => setOpen(false)}>
      <div className="space-y-4">
        <dl className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm">{details.map((detail) => <div key={detail} className="text-slate-300">{detail}</div>)}</dl>
        <label className="block text-sm">Motivo<select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="">Selecione</option>{reasons.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {reasonCode === "other" ? <label className="block text-sm">Detalhes<textarea value={reasonText} onChange={(event) => setReasonText(event.target.value)} className="mt-1 min-h-24 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"/></label> : null}
        {message ? <p className="text-sm text-amber-300" role="alert">{message}</p> : null}
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Cancelar</button><button type="button" onClick={confirm} disabled={pending || !reasonCode || (reasonCode === "other" && !reasonText.trim())} className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending ? "Excluindo..." : kind === "ticket" ? "Excluir ingresso" : "Excluir item"}</button></div>
      </div>
    </Dialog>
  </>;
}

export function OwnerCancelTicketButton(props: { contactId: string; ticketId: string; details: string[] }) { return <AdministrativeDeleteButton kind="ticket" entityId={props.ticketId} {...props}/>; }
export function OwnerCancelAdditionalItemButton(props: { contactId: string; itemId: string; details: string[] }) { return <AdministrativeDeleteButton kind="item" entityId={props.itemId} {...props}/>; }
