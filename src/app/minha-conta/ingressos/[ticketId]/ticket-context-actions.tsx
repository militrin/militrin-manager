"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { adminChangeTicketShirtAction, requestTicketItemChangeAction, updateTicketCategoryAction } from "@/app/minha-conta/actions";
import { TicketHolderActions } from "./ticket-holder-actions";

type Option = { value: string; label: string; disabled?: boolean };

function Dialog({ title, open, close, children }: { title: string; open: boolean; close: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" onMouseDown={(event) => { if (event.currentTarget === event.target) close(); }}>
    <div className="w-full max-w-lg rounded-3xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{title}</h2><button type="button" onClick={close} aria-label="Fechar" className="rounded-lg border border-slate-700 px-3 py-1">×</button></div>{children}</div>
  </div>;
}

export function HolderContextAction({ ticketId, hasHolder }: { ticketId: string; hasHolder: boolean }) {
  const [open,setOpen]=useState(false); const [notice,setNotice]=useState<string|null>(null);
  return <><button type="button" onClick={()=>setOpen(true)} className="text-xs font-medium text-emerald-300 hover:underline">Alterar</button>{notice?<span className="text-xs text-emerald-300">{notice}</span>:null}<Dialog title={hasHolder?'Alterar titular':'Definir titular'} open={open} close={()=>setOpen(false)}><div className="mt-4"><TicketHolderActions ticketId={ticketId} mode={hasHolder?'transfer':'define'} admin onSuccess={(message)=>{setNotice(message);setOpen(false);}}/></div></Dialog></>;
}

// warning+requireReason juntos = override administrativo (ex.: alterar
// categoria pos-pagamento/check-in): nunca silencioso -- exige um motivo
// textual, gravado pela propria RPC no audit_logs, igual ao padrao ja usado
// por owner_cancel_ticket/admin_transfer_ticket_ownership neste projeto.
function SelectAction({ label, buttonLabel, initial, options, save, warning, requireReason }: { label:string; buttonLabel:string; initial:string; options:Option[]; save:(value:string, reason?:string)=>Promise<{success:boolean;message:string}>; warning?: string; requireReason?: boolean }) {
  const [open,setOpen]=useState(false); const [value,setValue]=useState(initial); const [reason,setReason]=useState(''); const [message,setMessage]=useState<string|null>(null); const [pending,startTransition]=useTransition(); const router=useRouter();
  const submit=()=>startTransition(async()=>{const result=await save(value, requireReason ? reason.trim() : undefined);setMessage(result.message);if(result.success){router.refresh();setOpen(false);}});
  const canSubmit = Boolean(value) && (!requireReason || reason.trim().length > 0);
  return <><button type="button" onClick={()=>{setMessage(null);setReason('');setOpen(true);}} className="text-xs font-medium text-emerald-300 hover:underline">{buttonLabel}</button>{message&&!open?<span className="text-xs text-emerald-300">{message}</span>:null}<Dialog title={label} open={open} close={()=>setOpen(false)}><div className="mt-4 space-y-4"><select value={value} onChange={e=>setValue(e.target.value)} className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3"><option value="">Selecione</option>{options.map(o=><option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}</select>{warning?<div className="rounded-xl border border-amber-600/40 bg-amber-950/20 p-3 text-xs text-amber-100"><p>{warning}</p>{requireReason?<label className="mt-2 block space-y-1"><span className="font-medium">Motivo da alteração (obrigatório)</span><textarea value={reason} onChange={e=>setReason(e.target.value)} rows={2} className="w-full rounded-lg border border-amber-700/40 bg-slate-950 px-3 py-2 text-slate-100"/></label>:null}</div>:null}{message?<p className="text-sm text-rose-300">{message}</p>:null}<div className="flex justify-end gap-2"><button type="button" onClick={()=>setOpen(false)} className="rounded-xl border border-slate-700 px-4 py-2">Cancelar</button><button type="button" disabled={pending||!canSubmit} onClick={submit} className="rounded-xl bg-emerald-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-40">Salvar</button></div></div></Dialog></>;
}

export function CategoryContextAction({ ticketId, initial, options, orderConfirmed, checkedIn }: { ticketId:string; initial:string; options:Option[]; orderConfirmed?: boolean; checkedIn?: boolean }) {
  const requiresOverride = Boolean(orderConfirmed || checkedIn);
  const warning = checkedIn
    ? 'Este ingresso já teve check-in realizado. O kit pode já ter sido retirado com a categoria atual -- confirme que essa alteração é intencional e explique o motivo.'
    : orderConfirmed
      ? 'Este pedido já está confirmado (pago). Mudar a categoria agora não ajusta o valor pago pelo participante -- confirme que essa alteração é intencional e explique o motivo.'
      : undefined;
  return <SelectAction
    label="Alterar categoria"
    buttonLabel="Alterar"
    initial={initial}
    options={options}
    warning={warning}
    requireReason={requiresOverride}
    save={async (value, reason)=>{
      const form=new FormData();
      form.set('ticket_id',ticketId);
      form.set('ticket_category_id',value);
      if (requiresOverride) {
        form.set('confirm_after_payment','true');
        form.set('override_reason', reason ?? '');
      }
      return updateTicketCategoryAction(form);
    }}
  />;
}
export function ShirtContextAction({ ticketId, initial, options }: { ticketId:string; initial:string; options:Option[] }) {
  return <SelectAction label="Trocar camiseta" buttonLabel="Trocar" initial={initial} options={options} save={value=>adminChangeTicketShirtAction(ticketId,value)}/>;
}

export function ParticipantShirtChangeAction({ ticketId, kitItemId, currentLabel, options, disabledReason }: {
  ticketId: string;
  kitItemId: string;
  currentLabel: string;
  options: Option[];
  disabledReason?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submit() {
    if (!value) return;
    startTransition(async () => {
      const form = new FormData();
      form.set("ticket_id", ticketId);
      form.set("kit_item_id", kitItemId);
      form.set("requested_variant_id", value);
      const result = await requestTicketItemChangeAction(form);
      setMessage(result.message);
      if (result.success) {
        router.refresh();
        setOpen(false);
      }
    });
  }

  return <div className="mt-3 rounded-xl border border-slate-800 p-3">
    <p className="font-medium">Alterar tamanho da camiseta</p>
    <p className="mt-1 text-sm text-slate-400">Tamanho atual: <strong className="text-slate-200">{currentLabel}</strong></p>
    {disabledReason ? <p className="mt-2 text-xs text-amber-200">{disabledReason}</p> : <button type="button" onClick={() => { setMessage(null); setValue(""); setOpen(true); }} className="mt-3 rounded-lg border border-emerald-500/40 px-3 py-2 text-sm text-emerald-200">Alterar tamanho</button>}
    {message && !open ? <p className="mt-2 text-xs text-emerald-300">{message}</p> : null}
    <Dialog title="Alterar tamanho da camiseta" open={open} close={() => setOpen(false)}>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-slate-300">Tamanho atual: <strong className="text-white">{currentLabel}</strong></p>
        <label className="block space-y-2 text-sm"><span>Novo tamanho</span><select value={value} onChange={(event) => setValue(event.target.value)} className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3"><option value="">Selecione</option>{options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select></label>
        {message ? <p className="text-sm text-rose-300">{message}</p> : null}
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-slate-700 px-4 py-2">Cancelar</button><button type="button" onClick={submit} disabled={pending || !value} className="rounded-xl bg-emerald-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-40">Confirmar alteração</button></div>
      </div>
    </Dialog>
  </div>;
}
