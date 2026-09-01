"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cancelTicketAction, searchTicketHolderCandidatesAction, searchTicketOwnerAccountsAction, transferTicketHolderAction, transferTicketOwnershipAction } from "./actions";
import { SENSITIVE_ACTION_REASON_OPTIONS } from "@/lib/admin/sensitive-action-reasons";
import type { TicketOwnerHolderAction } from "@/lib/admin/ticket-owner-rpc";

type Candidate = {
  registration_contact_id: string;
  full_name: string;
  masked_email: string | null;
  masked_cpf: string | null;
  has_account: boolean;
};

type Props = {
  ticketId: string;
  currentHolder: string;
  buyer: string;
  currentOwner: string;
  currentOwnerUserId: string | null;
  status: string;
  canTransfer: boolean;
  canTransferOwnership: boolean;
  canCancel: boolean;
  blockedByCheckin: boolean;
  blockedByDelivery: boolean;
};

export function TicketOwnershipEditor(props: Props) {
  const router = useRouter();
  const [term, setTerm] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [reasonCode, setReasonCode] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [removeReasonCode, setRemoveReasonCode] = useState("");
  const [removeReasonText, setRemoveReasonText] = useState("");
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [displayedHolder, setDisplayedHolder] = useState(props.currentHolder);
  const [cancelReason, setCancelReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [replacementRequired, setReplacementRequired] = useState<"" | "yes" | "no">("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [ownerTerm,setOwnerTerm]=useState("");
  const [ownerCandidates,setOwnerCandidates]=useState<OwnerCandidate[]>([]);
  const [selectedOwner,setSelectedOwner]=useState<OwnerCandidate|null>(null);
  const [holderAction,setHolderAction]=useState<TicketOwnerHolderAction>("keep");
  const [ownerReasonCode,setOwnerReasonCode]=useState("");
  const [ownerReasonText,setOwnerReasonText]=useState("");

  function removeHolder() {
    start(async () => {
      try {
        const result = await transferTicketHolderAction(props.ticketId, null, removeReasonCode, removeReasonText);
        setMessage(result.message);
        if (!result.success) return;
        setDisplayedHolder("Titular não definido");
        setRemoveDialogOpen(false);
        setRemoveReasonCode("");
        setRemoveReasonText("");
        setSelected(null);
        router.refresh();
      } catch {
        setMessage("Não foi possível remover o titular. Tente novamente.");
      }
    });
  }

  function transferHolder() {
    if (!selected) return;
    start(async () => {
      try {
        const result = await transferTicketHolderAction(props.ticketId, selected.registration_contact_id, reasonCode, reasonText);
        setMessage(result.message);
        if (result.success) router.refresh();
      } catch {
        setMessage("Não foi possível transferir o titular. Tente novamente.");
      }
    });
  }

  return <div className="space-y-6">
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-xl border border-slate-800 p-4"><p className="text-xs text-slate-400">Titular atual</p><p>{displayedHolder}</p></div>
      <div className="rounded-xl border border-slate-800 p-4"><p className="text-xs text-slate-400">Proprietário atual</p><p>{props.currentOwner}</p></div>
      <div className="rounded-xl border border-slate-800 p-4"><p className="text-xs text-slate-400">Comprador do pedido (somente leitura)</p><p>{props.buyer}</p></div>
    </div>

    {props.canTransferOwnership && props.status !== "cancelled" ? <section id="propriedade" className="space-y-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
      <div><h2 className="font-semibold text-violet-100">Transferir propriedade</h2><p className="text-sm text-slate-400">Altera a conta que controla o ingresso. O comprador original e os dados comerciais não mudam.</p></div>
      <div className="flex gap-2"><input value={ownerTerm} onChange={(event)=>setOwnerTerm(event.target.value)} placeholder="Nome ou e-mail da conta NEXORA" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"/><button type="button" disabled={pending||ownerTerm.trim().length<3} onClick={()=>start(async()=>{const result=await searchTicketOwnerAccountsAction(props.ticketId,ownerTerm);setOwnerCandidates(result.candidates as OwnerCandidate[]);setSelectedOwner(null);setMessage(result.message);})} className="rounded-lg border border-slate-700 px-3">Buscar conta</button></div>
      <div className="space-y-2">{ownerCandidates.map((candidate)=><button type="button" key={candidate.user_id} onClick={()=>setSelectedOwner(candidate)} className={`block w-full rounded-lg border p-3 text-left ${selectedOwner?.user_id===candidate.user_id?"border-violet-400":"border-slate-800"}`}><strong>{candidate.full_name}</strong><span className="mt-1 block text-xs text-slate-400">{candidate.masked_email??"E-mail indisponível"} · Conta NEXORA{candidate.registration_contact_count===0?" · sem cadastro vinculado":candidate.registration_contact_count>1?" · vínculo de cadastro ambíguo":" · cadastro vinculado"}</span></button>)}</div>
      {selectedOwner?<div className="space-y-3 rounded-lg bg-slate-900 p-3">
        <div className="grid gap-1 text-sm"><p>Proprietário atual: <strong>{props.currentOwner}</strong></p><p>Novo proprietário: <strong>{selectedOwner.full_name}</strong></p><p>Comprador original continuará: <strong>{props.buyer}</strong></p></div>
        <label className="grid gap-1 text-sm"><span className="font-medium">Tratamento do titular</span><select value={holderAction} onChange={(event)=>setHolderAction(event.target.value as TicketOwnerHolderAction)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"><option value="keep">Manter titular atual ({displayedHolder})</option><option value="assign_new_owner" disabled={selectedOwner.registration_contact_count!==1}>Definir novo proprietário também como titular</option><option value="remove">Deixar sem titular</option></select></label>
        {selectedOwner.registration_contact_count!==1?<p className="text-xs text-amber-200">Esta conta não possui um único cadastro vinculado; ela pode receber a propriedade, mas não pode ser definida automaticamente como titular.</p>:null}
        <ReasonFields code={ownerReasonCode} text={ownerReasonText} setCode={setOwnerReasonCode} setText={setOwnerReasonText} disabled={pending}/>
        <div className="flex justify-end gap-2"><button type="button" disabled={pending} onClick={()=>setSelectedOwner(null)} className="rounded-lg border border-slate-700 px-3 py-2">Cancelar</button><button type="button" disabled={pending||!ownerReasonCode||(ownerReasonCode==="other"&&!ownerReasonText.trim())} onClick={()=>start(async()=>{const result=await transferTicketOwnershipAction({ticketId:props.ticketId,expectedOwnerUserId:props.currentOwnerUserId,newOwnerUserId:selectedOwner.user_id,holderAction,reasonCode:ownerReasonCode,reasonText:ownerReasonText});setMessage(result.message);if(result.success){setSelectedOwner(null);router.refresh();}})} className="rounded-lg bg-violet-400 px-3 py-2 font-semibold text-slate-950 disabled:opacity-50">Confirmar transferência</button></div>
      </div>:null}
    </section>:null}

    {props.canTransfer && props.status !== "cancelled" ? <section className="space-y-3 rounded-xl border border-slate-800 p-4">
      <h2 className="font-semibold">Transferir titularidade</h2>
      <div className="flex gap-2">
        <input value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Nome, e-mail, CPF ou PIN" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" />
        <button disabled={pending || term.trim().length < 3} onClick={() => start(async () => {
          const result = await searchTicketHolderCandidatesAction(props.ticketId, term);
          setCandidates(result.candidates as Candidate[]); setSelected(null); setMessage(result.message);
        })} className="rounded-lg border border-slate-700 px-3">Buscar</button>
      </div>
      <div className="space-y-2">{candidates.map((candidate) => <button type="button" key={candidate.registration_contact_id} onClick={() => setSelected(candidate)} className={`block w-full rounded-lg border p-3 text-left ${selected?.registration_contact_id === candidate.registration_contact_id ? "border-emerald-400" : "border-slate-800"}`}>
        <strong>{candidate.full_name}</strong><span className="mt-1 block text-xs text-slate-400">{candidate.masked_email ?? "E-mail indisponível"} · {candidate.masked_cpf ?? "CPF indisponível"} · {candidate.has_account ? "Conta vinculada" : "Sem conta"}</span>
      </button>)}</div>
      {selected ? <div className="space-y-3 rounded-lg bg-slate-900 p-3"><p className="text-sm text-slate-400">Novo titular: <strong className="text-slate-100">{selected.full_name}</strong></p>
        <ReasonFields code={reasonCode} text={reasonText} setCode={setReasonCode} setText={setReasonText} disabled={pending}/>
        <div className="flex justify-end gap-2"><button type="button" disabled={pending} onClick={() => setSelected(null)} className="rounded-lg border border-slate-700 px-3 py-2">Cancelar</button><button type="button" disabled={pending || !reasonCode || (reasonCode === "other" && !reasonText.trim())} onClick={transferHolder} className="rounded-lg bg-emerald-400 px-3 py-2 font-semibold text-slate-950 disabled:opacity-50">Transferir titularidade</button></div>
      </div> : null}
      <div className="border-t border-slate-800 pt-3"><p className="text-sm text-slate-400">Também é possível deixar o ingresso sem titular.</p><button type="button" disabled={pending} onClick={() => { setRemoveReasonCode(""); setRemoveReasonText(""); setMessage(null); setRemoveDialogOpen(true); }} className="mt-2 rounded-lg border border-amber-500/40 px-3 py-2 text-sm text-amber-200">Remover titular</button></div>
    </section> : null}

    {removeDialogOpen ? <div role="dialog" aria-modal="true" aria-labelledby="remove-holder-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg space-y-4 rounded-xl border border-amber-500/30 bg-slate-950 p-5 shadow-2xl">
        <h2 id="remove-holder-title" className="text-lg font-semibold text-amber-100">Remover titular</h2>
        <p>Remover {displayedHolder} como titular deste ingresso?</p>
        <ReasonFields code={removeReasonCode} text={removeReasonText} setCode={setRemoveReasonCode} setText={setRemoveReasonText} disabled={pending} autoFocus/>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={pending} onClick={() => setRemoveDialogOpen(false)} className="rounded-lg border border-slate-700 px-3 py-2">Cancelar</button>
          <button type="button" disabled={pending || !removeReasonCode || (removeReasonCode === "other" && !removeReasonText.trim())} onClick={removeHolder} className="rounded-lg bg-amber-500 px-3 py-2 font-semibold text-slate-950 disabled:opacity-50">{pending ? "Removendo..." : "Remover titular"}</button>
        </div>
      </div>
    </div> : null}

    {props.canCancel ? <section className="space-y-3 rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
      <h2 className="font-semibold text-rose-200">Cancelar ingresso</h2>
      {props.blockedByCheckin ? <p className="text-sm text-amber-200">Desfaça o check-in antes de cancelar.</p> : null}
      {props.blockedByDelivery ? <p className="text-sm text-amber-200">Desfaça a entrega dos itens antes de cancelar.</p> : null}
      <textarea value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} placeholder="Motivo obrigatório" disabled={props.status === "cancelled" || props.blockedByCheckin || props.blockedByDelivery} className="w-full rounded-lg border border-slate-700 bg-slate-950 p-3" />
      <label className="grid gap-1 text-sm"><span className="font-medium">Precisa de um ingresso substituto?</span><select value={replacementRequired} onChange={(event) => setReplacementRequired(event.target.value as "" | "yes" | "no")} disabled={props.status === "cancelled" || props.blockedByCheckin || props.blockedByDelivery} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"><option value="">Selecione</option><option value="no">Não — o entitlement acaba aqui</option><option value="yes">Sim — um novo ingresso ainda precisa ser emitido</option></select></label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Confirmo o cancelamento sem reembolso automático.</label>
      <button disabled={pending || props.status === "cancelled" || props.blockedByCheckin || props.blockedByDelivery || !cancelReason.trim() || !confirmed || !replacementRequired} onClick={() => start(async () => setMessage((await cancelTicketAction(props.ticketId, cancelReason, confirmed, replacementRequired === "yes")).message))} className="rounded-lg bg-rose-500 px-3 py-2 font-semibold text-white disabled:opacity-50">Cancelar ingresso</button>
    </section> : null}
    {message ? <p role="status" className="text-sm text-slate-300">{message}</p> : null}
  </div>;
}

type OwnerCandidate={user_id:string;full_name:string;masked_email:string|null;registration_contact_id:string|null;registration_contact_count:number};

function ReasonFields({code,text,setCode,setText,disabled,autoFocus=false}:{code:string;text:string;setCode:(value:string)=>void;setText:(value:string)=>void;disabled:boolean;autoFocus?:boolean}) {
  return <div className="grid gap-2">
    <label className="grid gap-1 text-sm"><span className="font-medium">Motivo da alteração</span><select autoFocus={autoFocus} value={code} onChange={(event)=>setCode(event.target.value)} disabled={disabled} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"><option value="">Selecione</option>{SENSITIVE_ACTION_REASON_OPTIONS.map((reason)=><option key={reason.code} value={reason.code}>{reason.label}</option>)}</select></label>
    {code === "other" ? <label className="grid gap-1 text-sm"><span className="font-medium">Descreva o motivo</span><input value={text} onChange={(event)=>setText(event.target.value)} disabled={disabled} required className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"/></label> : code ? <label className="grid gap-1 text-sm"><span className="text-slate-400">Observação complementar <span className="text-xs">(opcional)</span></span><input value={text} onChange={(event)=>setText(event.target.value)} disabled={disabled} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"/></label> : null}
  </div>;
}
