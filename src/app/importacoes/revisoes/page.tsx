import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getCurrentOrganizationContext } from '@/lib/organizations/current-organization';
import { resolveImportReviewAction } from '../actions';
import { redirect } from 'next/navigation';
import { importRowHasExistingCpfIdentity } from '@/lib/imports/identity-review';

type Candidate = {
  registration_contact_id?: string;
  participant_id?: string | null;
  user_id?: string | null;
  full_name?: string;
  cpf?: string;
  email?: string;
  reason?: string;
};

const labels: Record<string, string> = {
  cpf_exact: 'CPF exato', email_exact: 'E-mail exato', name_exact_suggestion: 'Nome semelhante',
  strong_identifier_conflict: 'CPF e e-mail apontam para pessoas diferentes',
  email_exact_requires_review: 'E-mail exato requer confirmação', name_only_suggestion: 'Somente nome; não vincular automaticamente',
  legacy_name_only_suggestion: 'Revisão antiga sugerida somente pelo nome',
};

function maskCpf(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits.length === 11 ? `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**` : 'Não informado/válido';
}

export default async function ImportReviewQueuePage({ searchParams }: { searchParams: Promise<{ batchId?: string; error?: string }> }) {
  async function submitReview(formData: FormData) {
    'use server';
    const result = await resolveImportReviewAction(formData);
    const filterBatchId = String(formData.get('filter_batch_id') ?? '');
    const qs = new URLSearchParams();
    if (filterBatchId) qs.set('batchId', filterBatchId);
    if (!result.success) qs.set('error', result.message);
    redirect(`/importacoes/revisoes${qs.toString() ? `?${qs.toString()}` : ''}`);
  }
  const { batchId, error: reviewError } = await searchParams;
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization) redirect('/painel');
  const supabase = await createServerSupabaseClient();
  let query = supabase.from('import_batch_rows').select(`
    id,row_number,import_batch_id,normalized_data,error_message,identity_match_details,created_at,
    import_batches!inner(id,file_name,event_id,organization_id,created_at,events(name))
  `).eq('status', 'review_required').eq('resolution', 'pending')
    .eq('import_batches.organization_id', organization.id).order('created_at', { ascending: true });
  if (batchId) query = query.eq('import_batch_id', batchId);
  const { data: rows, error } = await query;
  if (error) throw error;

  return <section className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">Revisões pendentes</h1><p className="text-sm text-slate-400">{rows?.length ?? 0} linha(s) aguardando decisão explícita.</p></div>
      <Link href="/importacoes" className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Voltar às importações</Link>
    </div>
    {reviewError ? <div className="rounded-2xl border border-rose-700 bg-rose-950/40 p-4 text-sm text-rose-200">Não foi possível concluir a decisão: {reviewError}</div> : null}
    {(rows ?? []).map((row) => {
      const imported = row.normalized_data as Record<string, unknown>;
      const details = row.identity_match_details as { reason?: string; candidates?: Candidate[] };
      const candidates = details?.candidates ?? [];
      const hasExistingCpf = importRowHasExistingCpfIdentity(details, String(imported.cpf ?? imported.cpf_input ?? ''));
      const batch = Array.isArray(row.import_batches) ? row.import_batches[0] : row.import_batches;
      const event = batch && (Array.isArray(batch.events) ? batch.events[0] : batch.events);
      return <article key={row.id} className="rounded-3xl border border-amber-700/50 bg-slate-900/80 p-5">
        <div className="flex flex-wrap justify-between gap-2"><div><p className="text-xs uppercase tracking-wide text-amber-300">Linha {row.row_number} · {batch?.file_name}</p><h2 className="mt-1 text-lg font-semibold">{String(imported.full_name ?? 'Sem nome')}</h2><p className="text-xs text-slate-400">{event?.name ?? 'Evento'} · batch {String(row.import_batch_id).slice(0, 8)}</p></div><span className="h-fit rounded-full bg-amber-400/15 px-3 py-1 text-xs text-amber-200">{labels[details?.reason ?? ''] ?? row.error_message}</span></div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-700 p-4"><h3 className="font-medium">Linha importada</h3><dl className="mt-3 grid grid-cols-2 gap-2 text-sm"><dt className="text-slate-500">Nome</dt><dd>{String(imported.full_name ?? '-')}</dd><dt className="text-slate-500">CPF</dt><dd>{maskCpf(String(imported.cpf ?? imported.cpf_input ?? ''))}</dd><dt className="text-slate-500">E-mail</dt><dd>{String(imported.email ?? '-')}</dd><dt className="text-slate-500">Telefone</dt><dd>{String(imported.phone ?? '-')}</dd><dt className="text-slate-500">Nascimento</dt><dd>{String(imported.birth_date ?? '-')}</dd></dl></div>
          <div className="space-y-3"><h3 className="font-medium">Candidatos encontrados</h3>{candidates.map((candidate) => <div key={`${candidate.registration_contact_id}-${candidate.reason}`} className="rounded-2xl border border-slate-700 p-4 text-sm"><p className="font-semibold">{candidate.full_name || 'Cadastro sem nome'}</p><p className="text-xs text-emerald-300">{labels[candidate.reason ?? ''] ?? candidate.reason}</p><p className="mt-2 text-slate-400">CPF: {maskCpf(candidate.cpf ?? '')} · E-mail: {candidate.email || '-'}</p><form action={submitReview} className="mt-3"><input type="hidden" name="row_id" value={row.id}/><input type="hidden" name="filter_batch_id" value={batchId ?? ''}/><input type="hidden" name="decision" value="link_existing"/><input type="hidden" name="registration_contact_id" value={candidate.registration_contact_id}/><button className="rounded-xl bg-emerald-400 px-4 py-2 font-semibold text-emerald-950">É a mesma pessoa / vincular</button></form></div>)}</div>
        </div>
        <div className="mt-4 rounded-2xl bg-slate-950/60 p-3 text-xs text-slate-400">{hasExistingCpf ? 'Este CPF já identifica um cadastro. Vincular reutiliza essa Pessoa; ignorar encerra a linha sem criar pedido, item ou ingresso. Não é possível criar outra Pessoa com o mesmo CPF. A decisão fica registrada em auditoria.' : 'Vincular reutiliza o cadastro e preserva sua conta; criar novo só se aplica quando o CPF ainda não existe; ignorar encerra a linha sem criar pedido, item ou ingresso. A decisão fica registrada em auditoria.'}</div>
        <div className="mt-4 flex flex-wrap gap-3">{hasExistingCpf ? null : <form action={submitReview}><input type="hidden" name="row_id" value={row.id}/><input type="hidden" name="filter_batch_id" value={batchId ?? ''}/><input type="hidden" name="decision" value="create_new"/><button className="rounded-xl border border-sky-600 px-4 py-2 text-sm text-sky-200">É outra pessoa / criar novo</button></form>}<form action={submitReview}><input type="hidden" name="row_id" value={row.id}/><input type="hidden" name="filter_batch_id" value={batchId ?? ''}/><input type="hidden" name="decision" value="ignore"/><button className="rounded-xl border border-rose-800 px-4 py-2 text-sm text-rose-300">Ignorar linha</button></form><Link href={`/importacoes?batchId=${row.import_batch_id}`} className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Abrir e reprocessar batch</Link></div>
      </article>;
    })}
    {!rows?.length ? <div className="rounded-3xl border border-dashed border-slate-700 p-10 text-center text-slate-400">Nenhuma revisão pendente.</div> : null}
  </section>;
}
