import { notFound } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { updateCadastroAction } from "./actions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { DeleteCadastroButton } from "./delete-cadastro-button";

export default async function EditarCadastroPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ erro?: string; sucesso?: string }> }) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createServerSupabaseClient();
  const [{ data: person, error }, organizationContext] = await Promise.all([
    supabase.from("registration_contacts").select("id,full_name,cpf,birth_date,gender,phone,email,city,user_id").eq("id", id).maybeSingle(),
    getCurrentOrganizationContext(),
  ]);
  if (error) throw error;
  if (!person) notFound();
  const action = updateCadastroAction.bind(null, id);

  return <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100"><div className="mx-auto flex max-w-6xl gap-6"><Sidebar/><div className="flex-1 space-y-6"><TopBar title="Editar cadastro" subtitle="Somente dados pessoais" breadcrumbs={[{label:"Início",href:"/painel"},{label:"Cadastros",href:"/cadastros"},{label:String(person.full_name),href:`/cadastros/${id}`},{label:"Editar cadastro"}]} backHref={`/cadastros/${id}`} fallbackHref="/cadastros"/>
    <form action={action} className="space-y-5 rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
      <p className="text-sm text-slate-400">Esta edição não altera comprador, titularidade, pedido, ingresso, categoria ou itens.</p>
      {query.erro ? <p className="rounded-xl bg-rose-500/10 p-3 text-sm text-rose-200">{query.erro}</p> : null}
      {query.sucesso ? <p className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-200">Cadastro atualizado e pendências reavaliadas.</p> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-1"><span>Nome</span><input name="full_name" required defaultValue={person.full_name ?? ""} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"/></label>
        <label className="space-y-1"><span>CPF</span><input name="cpf" defaultValue={person.cpf ?? ""} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"/></label>
        <label className="space-y-1"><span>Data de nascimento</span><input type="date" name="birth_date" defaultValue={person.birth_date ?? ""} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"/></label>
        <label className="space-y-1"><span>Gênero</span><select name="gender" defaultValue={person.gender ?? ""} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="">Não informado</option><option value="male">Masculino</option><option value="female">Feminino</option></select></label>
        <label className="space-y-1"><span>Telefone</span><input name="phone" defaultValue={person.phone ?? ""} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"/></label>
        <label className="space-y-1"><span>E-mail</span><input type="email" name="email" defaultValue={person.email ?? ""} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"/></label>
        <label className="space-y-1"><span>Cidade</span><input name="city" defaultValue={person.city ?? ""} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"/></label>
      </div><div className="flex justify-end"><button className="rounded-xl bg-emerald-500 px-5 py-2.5 font-semibold text-emerald-950">Salvar cadastro</button></div>
    </form>
    {organizationContext.isOrgOwner ? <section className="rounded-3xl border border-rose-500/30 bg-rose-500/5 p-6">
      <h2 className="text-lg font-semibold text-rose-100">Zona de perigo</h2>
      <p className="mt-1 text-sm text-slate-400">A exclusao e definitiva. Uma conta de acesso vinculada tambem sera removida; historico operacional, financeiro ou de participacao bloqueia a exclusao.</p>
      <div className="mt-4"><DeleteCadastroButton contactId={id} fullName={String(person.full_name)} hasLinkedAccount={Boolean(person.user_id)}/></div>
    </section> : null}
  </div></div></main>;
}
