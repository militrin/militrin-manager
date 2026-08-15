import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ParticipantIssuesDialog, type ParticipantDataIssue } from "@/app/inscricoes/participant-issues-dialog";

export default async function MinhasPendenciasPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) redirect("/entrar?next=/primeiro-acesso/pendencias");
  const { data: people, error } = await supabase.from("participants").select(`id,full_name,participant_data_issues(id,status,resolution_scope,field_code,issue_type,message,blocks_payment,blocks_ticket_issuance,blocks_checkin,blocks_kit_delivery)`).eq("user_id", user.id);
  if (error) throw error;
  const rows = (people ?? []).map((person) => ({ id: String(person.id), name: String(person.full_name ?? ""), issues: (person.participant_data_issues ?? []).filter((issue) => issue.status === "open") as Array<ParticipantDataIssue & { resolution_scope?: string }> }));
  const open = rows.flatMap((row) => row.issues);
  if (!open.length) redirect("/minha-conta/ingressos");
  const userRows = rows.map((row) => ({ ...row, issues: row.issues.filter((issue) => issue.resolution_scope === "user_resolvable") })).filter((row) => row.issues.length);
  const adminOnlyCount = open.filter((issue) => issue.resolution_scope !== "user_resolvable").length;
  return <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100"><section className="mx-auto max-w-2xl space-y-5 rounded-3xl border border-slate-800 bg-slate-900/80 p-6"><div><h1 className="text-2xl font-semibold">Complete seu cadastro para continuar</h1><p className="mt-2 text-sm text-slate-300">Corrija os dados abaixo. O mesmo cadastro e ingresso serão preservados.</p></div>
    {userRows.map((row) => <div key={row.id} className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4"><p className="font-medium">{row.name}</p><p className="mt-1 text-sm text-amber-200">{row.issues.length} pendência(s) que você pode corrigir.</p><div className="mt-3"><ParticipantIssuesDialog participantId={row.id} participantName={row.name} issues={row.issues} expectedIssueIds={rows.find((item) => item.id === row.id)?.issues.map((issue) => issue.id)} canEdit mode="self" triggerLabel="Completar cadastro"/></div></div>)}
    {!userRows.length && adminOnlyCount ? <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4"><p className="font-medium text-cyan-100">Cadastro enviado para conferência do organizador</p><p className="mt-1 text-sm text-cyan-200">Ainda existem {adminOnlyCount} pendência(s) que dependem da organização. O ingresso permanecerá bloqueado até a análise.</p></div> : null}
  </section></main>;
}
