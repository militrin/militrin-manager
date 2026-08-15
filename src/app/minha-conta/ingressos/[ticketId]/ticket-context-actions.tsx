"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { adminChangeTicketShirtAction, updateTicketCategoryAction } from "@/app/minha-conta/actions";
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

function SelectAction({ label, buttonLabel, initial, options, save }: { label:string; buttonLabel:string; initial:string; options:Option[]; save:(value:string)=>Promise<{success:boolean;message:string}> }) {
  const [open,setOpen]=useState(false); const [value,setValue]=useState(initial); const [message,setMessage]=useState<string|null>(null); const [pending,startTransition]=useTransition(); const router=useRouter();
  const submit=()=>startTransition(async()=>{const result=await save(value);setMessage(result.message);if(result.success){router.refresh();setOpen(false);}});
  return <><button type="button" onClick={()=>{setMessage(null);setOpen(true);}} className="text-xs font-medium text-emerald-300 hover:underline">{buttonLabel}</button>{message&&!open?<span className="text-xs text-emerald-300">{message}</span>:null}<Dialog title={label} open={open} close={()=>setOpen(false)}><div className="mt-4 space-y-4"><select value={value} onChange={e=>setValue(e.target.value)} className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3"><option value="">Selecione</option>{options.map(o=><option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}</select>{message?<p className="text-sm text-rose-300">{message}</p>:null}<div className="flex justify-end gap-2"><button type="button" onClick={()=>setOpen(false)} className="rounded-xl border border-slate-700 px-4 py-2">Cancelar</button><button type="button" disabled={pending||!value} onClick={submit} className="rounded-xl bg-emerald-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-40">Salvar</button></div></div></Dialog></>;
}

export function CategoryContextAction({ ticketId, initial, options }: { ticketId:string; initial:string; options:Option[] }) {
  return <SelectAction label="Alterar categoria" buttonLabel="Alterar" initial={initial} options={options} save={async value=>{const form=new FormData();form.set('ticket_id',ticketId);form.set('ticket_category_id',value);return updateTicketCategoryAction(form);}}/>;
}
export function ShirtContextAction({ ticketId, initial, options }: { ticketId:string; initial:string; options:Option[] }) {
  return <SelectAction label="Trocar camiseta" buttonLabel="Trocar" initial={initial} options={options} save={value=>adminChangeTicketShirtAction(ticketId,value)}/>;
}
