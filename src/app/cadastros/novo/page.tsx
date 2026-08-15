import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { createContactAction } from "./actions";

export default async function NewContactPage({ searchParams }: { searchParams: Promise<Record<string,string|undefined>> }) {
  const query=await searchParams;
  const fields=[
    ["full_name","Nome completo","text"],["cpf","CPF","text"],["birth_date","Data de nascimento (dd/mm/aaaa)","text"],
    ["phone","Telefone","text"],["email","E-mail","email"],["city","Cidade","text"],
  ] as const;
  return <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100"><div className="mx-auto flex max-w-7xl gap-6"><Sidebar/><div className="flex-1 space-y-6">
    <TopBar title="Novo cadastro" subtitle="Cadastros" breadcrumbs={[{label:"Início",href:"/painel"},{label:"Cadastros",href:"/cadastros"},{label:"Novo cadastro"}]} backHref="/cadastros" fallbackHref="/cadastros"/>
    <SectionCard title="Dados da pessoa" description="Este cadastro não cria pedido, pagamento, ingresso, QR Code, kit ou check-in.">
      {query.erro?<p className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-red-200">{query.erro}</p>:null}
      {query.sucesso?<div className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-200"><p>Cadastro salvo com sucesso. PIN: <strong className="font-mono">{query.pin}</strong></p><Link className="mt-3 inline-flex rounded-lg bg-emerald-500 px-3 py-2 font-semibold text-emerald-950" href={`/ingressos/emitir?pin=${query.pin}`}>Emitir ingresso para este cadastro</Link></div>:null}
      <form action={createContactAction} className="grid gap-4 md:grid-cols-2">
        {fields.map(([name,label,type])=><label key={name} className="space-y-2 text-sm"><span className="text-slate-300">{label}</span><input required name={name} type={type} className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3"/></label>)}
        <label className="space-y-2 text-sm"><span className="text-slate-300">Sexo/gênero</span><select name="gender" className="w-full rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3"><option value="">Não informado</option><option>Masculino</option><option>Feminino</option><option>Outro</option></select></label>
        <div className="md:col-span-2"><button className="rounded-xl bg-emerald-500 px-4 py-3 font-semibold text-emerald-950">Salvar cadastro</button></div>
      </form>
    </SectionCard>
  </div></div></main>;
}
