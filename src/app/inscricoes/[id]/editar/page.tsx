"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { BirthDateInput } from "@/components/forms/BirthDateInput";
import { formatISOToDateBR, isValidDateBR, parseDateBRToISO } from "@/lib/utils/date";
import { changeParticipantShirtFromEditAction, confirmParticipantPaymentFromEditAction, correctParticipantShirtAfterOperationAction, getParticipantEditContext, updateParticipantDetails } from "./actions";
import { REASON_CODES, REASON_CODE_LABELS, type ReasonCode } from "@/app/operacoes/types";

type Participant = { id:string; full_name:string; birth_date:string|null; phone:string|null; email:string|null; city:string|null; gender:string|null; shirt_type:string|null; shirt_size:string|null; notes:string|null; payment_status:string };
type ShirtOption = { shirt_type:string; shirt_size:string; supply_mode:string; option_label:string };
const genderOptions = [{value:"male",label:"Masculino"},{value:"female",label:"Feminino"},{value:"other",label:"Outro"},{value:"prefer_not_to_say",label:"Prefiro não informar"}];
const paymentLabels:Record<string,string>={paid:"Confirmado",pending:"Pendente",refunded:"Reembolsado",failed:"Falhou",cancelled:"Cancelado",processing:"Processando",expired:"Expirado"};
const inputClass="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3";

export default function EditParticipantPage({params}:{params:Promise<{id:string}>}) {
  const router=useRouter();
  const [participant,setParticipant]=useState<Participant|null>(null);
  const [birthDate,setBirthDate]=useState(""); const [message,setMessage]=useState<string|null>(null);
  const [loading,setLoading]=useState(true); const [saving,setSaving]=useState(false);
  const [ticketId,setTicketId]=useState<string|null>(null); const [shirtOptions,setShirtOptions]=useState<ShirtOption[]>([]);
  const [shirtType,setShirtType]=useState(""); const [shirtSize,setShirtSize]=useState("");
  const [shirtLocked,setShirtLocked]=useState(false); const [canChangeShirt,setCanChangeShirt]=useState(false); const [canConfirmPayment,setCanConfirmPayment]=useState(false);
  const [correctionReasonCode,setCorrectionReasonCode]=useState<ReasonCode|"">(""); const [correctionReasonText,setCorrectionReasonText]=useState("");

  useEffect(()=>{ void (async()=>{ try { const {id}=await params; const context=await getParticipantEditContext(id); const row=context.participant;
    setParticipant({...row,payment_status:String(context.payment?.payment_status??"pending")}); setBirthDate(formatISOToDateBR(row.birth_date));
    setTicketId(context.ticketId); setShirtOptions(context.shirtOptions as ShirtOption[]); setShirtType(String(row.shirt_type??"")); setShirtSize(String(row.shirt_size??""));
    setShirtLocked(context.shirtLocked); setCanChangeShirt(context.canChangeShirt); setCanConfirmPayment(context.canConfirmPayment);
  } catch(error){setMessage(error instanceof Error?error.message:"Não foi possível carregar o cadastro.");} finally{setLoading(false);} })(); },[params]);

  const shirtTypes=useMemo(()=>Array.from(new Set(shirtOptions.map(option=>option.shirt_type))),[shirtOptions]);
  const shirtSizes=useMemo(()=>shirtOptions.filter(option=>option.shirt_type===shirtType).map(option=>option.shirt_size),[shirtOptions,shirtType]);

  async function onSubmit(event:React.FormEvent<HTMLFormElement>){event.preventDefault();if(!participant)return;
    if(!isValidDateBR(birthDate)){setMessage("Informe uma data válida no formato dd/MM/aaaa.");return;} const birth_date=parseDateBRToISO(birthDate);if(!birth_date)return;
    const form=new FormData(event.currentTarget);setSaving(true);setMessage(null);try{await updateParticipantDetails({id:participant.id,full_name:String(form.get("full_name")??""),birth_date,phone:String(form.get("phone")??""),email:String(form.get("email")??""),city:String(form.get("city")??"")||null,gender:String(form.get("gender")??"")||null,notes:String(form.get("notes")??"")||null});setMessage("Dados cadastrais atualizados.");router.back();}catch(error){setMessage(error instanceof Error?error.message:"Não foi possível atualizar o cadastro.");}finally{setSaving(false);}}
  async function confirmPayment(){if(!participant)return;setSaving(true);setMessage(null);try{const result=await confirmParticipantPaymentFromEditAction(participant.id);setMessage(result.message);if(result.success)setParticipant({...participant,payment_status:"paid"});}catch(error){setMessage(error instanceof Error?error.message:"Não foi possível confirmar o pagamento.");}finally{setSaving(false);}}
  async function saveShirt(){if(!participant||!ticketId)return;setSaving(true);setMessage(null);try{const result=await changeParticipantShirtFromEditAction({participantId:participant.id,ticketId,shirtType,shirtSize});setMessage(result.message);}catch(error){setMessage(error instanceof Error?error.message:"Não foi possível alterar a camiseta.");}finally{setSaving(false);}}
  async function correctShirt(){if(!participant||!ticketId||!correctionReasonCode)return;setSaving(true);setMessage(null);try{const result=await correctParticipantShirtAfterOperationAction({participantId:participant.id,ticketId,shirtType,shirtSize,reasonCode:correctionReasonCode,reasonText:correctionReasonText});setMessage(result.message);setCorrectionReasonCode("");setCorrectionReasonText("");}catch(error){setMessage(error instanceof Error?error.message:"Não foi possível corrigir o tamanho.");}finally{setSaving(false);}}

  if(loading)return <div className="p-8 text-slate-200">Carregando...</div>;
  if(!participant)return <div className="p-8 text-rose-200">{message??"Cadastro não encontrado."}</div>;
  const participantHref=`/inscricoes/${participant.id}`;
  return <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8"><div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row"><Sidebar/><div className="flex-1 space-y-6"><TopBar title="Editar inscrito" subtitle="Dados cadastrais, pagamento e camiseta usam operações separadas" breadcrumbs={[{label:"Início",href:"/painel"},{label:"Inscrições",href:"/inscricoes"},{label:participant.full_name,href:participantHref},{label:"Editar inscrito"}]} backHref={participantHref} fallbackHref="/inscricoes"/><SectionCard title="Dados do participante" description="Salvar alterações modifica somente os dados cadastrais permitidos.">
    <form onSubmit={onSubmit} className="space-y-5">{message?<div className="rounded-2xl bg-slate-950/70 p-3 text-sm text-slate-300">{message}</div>:null}<div className="grid gap-4 md:grid-cols-2">
      <label className="space-y-2 text-sm"><span>Nome</span><input defaultValue={participant.full_name} name="full_name" className={inputClass}/></label><BirthDateInput name="birth_date" value={birthDate} onChange={setBirthDate} required/>
      <label className="space-y-2 text-sm"><span>Telefone</span><input defaultValue={participant.phone??""} name="phone" className={inputClass}/></label><label className="space-y-2 text-sm"><span>E-mail</span><input type="email" required defaultValue={participant.email??""} name="email" className={inputClass}/></label>
      <label className="space-y-2 text-sm"><span>Cidade</span><input defaultValue={participant.city??""} name="city" className={inputClass}/></label><label className="space-y-2 text-sm"><span>Sexo</span><select defaultValue={participant.gender??""} name="gender" className={inputClass}><option value="">Selecione</option>{genderOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
    </div><label className="block space-y-2 text-sm"><span>Observações</span><textarea defaultValue={participant.notes??""} name="notes" rows={4} className={inputClass}/></label><div className="flex justify-end"><button type="submit" disabled={saving} className="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">{saving?"Salvando...":"Salvar alterações"}</button></div></form>
    <div className="mt-6 border-t border-slate-800 pt-5"><p className="text-sm font-semibold">Status do pagamento</p><p className="mt-2 text-sm">{paymentLabels[participant.payment_status]??participant.payment_status}</p>{participant.payment_status==="pending"&&canConfirmPayment?<button type="button" onClick={confirmPayment} disabled={saving} className="mt-3 rounded-xl border border-emerald-500/40 px-3 py-2 text-sm text-emerald-200">Confirmar pagamento</button>:null}</div>
    {ticketId&&canChangeShirt?<div className="mt-6 space-y-4 border-t border-slate-800 pt-5"><div><p className="text-sm font-semibold">Camiseta do ingresso</p><p className="text-xs text-emerald-200">Sob encomenda</p></div><div className="grid gap-4 md:grid-cols-2"><label className="space-y-2 text-sm"><span>Modelo</span><select value={shirtType} onChange={event=>{setShirtType(event.target.value);setShirtSize("");}} disabled={shirtLocked} className={inputClass}><option value="">Selecione</option>{shirtTypes.map(type=><option key={type}>{type}</option>)}</select></label><label className="space-y-2 text-sm"><span>Tamanho</span><select value={shirtSize} onChange={event=>setShirtSize(event.target.value)} disabled={shirtLocked||!shirtType} className={inputClass}><option value="">Selecione</option>{shirtSizes.map(size=><option key={size}>{size}</option>)}</select></label></div>
      {shirtLocked?<div className="space-y-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
        <p className="text-sm text-amber-200">O tamanho não pode mais ser alterado porque este ingresso já teve kit entregue ou check-in realizado. Para corrigir, selecione o novo tamanho, informe o motivo e confirme abaixo.</p>
        <label className="block space-y-2 text-sm"><span>Motivo da correção</span><select value={correctionReasonCode} onChange={event=>setCorrectionReasonCode(event.target.value as ReasonCode)} className={inputClass}><option value="">Selecione</option>{REASON_CODES.map(code=><option key={code} value={code}>{REASON_CODE_LABELS[code]}</option>)}</select></label>
        {correctionReasonCode==="other"?<label className="block space-y-2 text-sm"><span>Descreva o motivo</span><textarea value={correctionReasonText} onChange={event=>setCorrectionReasonText(event.target.value)} rows={3} className={inputClass}/></label>:null}
        <button type="button" onClick={()=>void correctShirt()} disabled={saving||!shirtType||!shirtSize||!correctionReasonCode||(correctionReasonCode==="other"&&!correctionReasonText.trim())} className="rounded-xl border border-amber-500/40 px-3 py-2 text-sm text-amber-200 disabled:opacity-50">Corrigir tamanho após operação</button>
      </div>:<button type="button" onClick={saveShirt} disabled={saving||!shirtType||!shirtSize} className="rounded-xl border border-emerald-500/40 px-3 py-2 text-sm text-emerald-200 disabled:opacity-50">Salvar camiseta</button>}
    </div>:null}
  </SectionCard></div></div></main>;
}
