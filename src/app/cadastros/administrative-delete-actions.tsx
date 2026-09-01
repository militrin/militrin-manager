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

function AdministrativeDeleteButton({ kind, contactId, entityId, details, alreadyCancelled }: { kind: "ticket" | "item"; contactId: string; entityId: string; details: string[]; alreadyCancelled?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false); const [reasonCode, setReasonCode] = useState(""); const [reasonText, setReasonText] = useState("");
  const [replacementRequired, setReplacementRequired] = useState<"" | "yes" | "no">("");
  const [message, setMessage] = useState(""); const [pending, startTransition] = useTransition();
  const isTicket = kind === "ticket";
  function confirm() { startTransition(async () => {
    const payload = { contactId, reasonCode, reasonText };
    const result = isTicket
      ? await cancelCadastroTicketAction({ ...payload, ticketId: entityId, replacementRequired: replacementRequired === "yes" })
      : await cancelCadastroAdditionalItemAction({ ...payload, itemId: entityId });
    setMessage(result.message); if (result.success) { setOpen(false); router.refresh(); }
  }); }
  const canSubmit = Boolean(reasonCode) && (reasonCode !== "other" || Boolean(reasonText.trim())) && (!isTicket || replacementRequired !== "");
  const triggerLabel = isTicket && alreadyCancelled ? "Definir substituição" : isTicket ? "Excluir ingresso" : "Excluir item";
  const dialogTitle = isTicket && alreadyCancelled ? "Este ingresso já foi excluído — precisa de substituto?" : isTicket ? "Excluir ingresso?" : "Excluir item adicional?";
  const confirmLabel = isTicket && alreadyCancelled ? "Salvar decisão" : isTicket ? "Excluir ingresso" : "Excluir item";
  return <>
    <button type="button" onClick={() => { setMessage(""); setOpen(true); }} className="text-xs font-semibold text-red-300 hover:text-red-200">{triggerLabel}</button>
    <Dialog title={dialogTitle} open={open} close={() => setOpen(false)}>
      <div className="space-y-4">
        <dl className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm">{details.map((detail) => <div key={detail} className="text-slate-300">{detail}</div>)}</dl>
        {isTicket && alreadyCancelled ? <p className="text-xs text-slate-400">Este ingresso já está cancelado. Registre aqui se a exclusão encerra o entitlement definitivamente ou se um novo ingresso ainda precisa ser emitido — a Central de Integridade usa essa decisão para saber se deve continuar cobrando a emissão.</p> : null}
        <label className="block text-sm">Motivo<select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="">Selecione</option>{reasons.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {reasonCode === "other" ? <label className="block text-sm">Detalhes<textarea value={reasonText} onChange={(event) => setReasonText(event.target.value)} className="mt-1 min-h-24 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"/></label> : null}
        {isTicket ? <label className="block text-sm">Precisa de um ingresso substituto?<select value={replacementRequired} onChange={(event) => setReplacementRequired(event.target.value as "" | "yes" | "no")} className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="">Selecione</option><option value="no">Não — o entitlement acaba aqui</option><option value="yes">Sim — um novo ingresso ainda precisa ser emitido</option></select></label> : null}
        {message ? <p className="text-sm text-amber-300" role="alert">{message}</p> : null}
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Cancelar</button><button type="button" onClick={confirm} disabled={pending || !canSubmit} className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending ? "Salvando..." : confirmLabel}</button></div>
      </div>
    </Dialog>
  </>;
}

export function OwnerCancelTicketButton(props: { contactId: string; ticketId: string; details: string[]; alreadyCancelled?: boolean }) { return <AdministrativeDeleteButton kind="ticket" entityId={props.ticketId} {...props}/>; }
export function OwnerCancelAdditionalItemButton(props: { contactId: string; itemId: string; details: string[] }) { return <AdministrativeDeleteButton kind="item" entityId={props.itemId} {...props}/>; }
