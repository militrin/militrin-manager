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
  cpf_exact: 'CPF exato',
  email_exact: 'E-mail exato',
  name_exact_suggestion: 'Nome semelhante',
  strong_identifier_conflict: 'CPF e e-mail apontam para pessoas diferentes',
  email_exact_requires_review: 'E-mail exato requer confirmação',
  name_only_suggestion: 'Somente nome; não vincular automaticamente',
  legacy_name_only_suggestion: 'Revisão antiga sugerida somente pelo nome',
  excel_leading_zero: 'Possível zero inicial removido pelo Excel',
  possible_reimport: 'Possível compra já importada',
  shared_email_account_review: 'E-mail compartilhado — revisão de conta',
  shared_email: 'E-mail compartilhado',
  additional_purchase: 'Compra adicional da mesma Pessoa',
};

function maskCpf(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits.length === 11 ? `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**` : 'Não informado/válido';
}

function isPendingReview(row: {
  status: string;
  resolution: string;
  identity_match_details: { reason?: string; account_review?: string; account_review_resolved?: string };
}) {
  if (row.status === 'review_required' && row.resolution === 'pending') return true;
  return row.identity_match_details?.account_review === 'shared_email'
    && !row.identity_match_details?.account_review_resolved;
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
    id,row_number,import_batch_id,status,resolution,normalized_data,error_message,identity_match_details,cpf_excel_candidate,order_item_id,created_at,
    import_batches!inner(id,file_name,event_id,organization_id,created_at,events(name))
  `).eq('import_batches.organization_id', organization.id).order('created_at', { ascending: true });
  if (batchId) query = query.eq('import_batch_id', batchId);
  const { data: loaded, error } = await query;
  if (error) throw error;
  const rows = (loaded ?? []).filter((row) => isPendingReview({
    status: String(row.status),
    resolution: String(row.resolution),
    identity_match_details: (row.identity_match_details ?? {}) as { reason?: string; account_review?: string; account_review_resolved?: string },
  }));
  const sharedEmails = Array.from(new Set(rows.map((row) => {
    const imported = row.normalized_data as Record<string, unknown>;
    return String(imported.email ?? '').trim().toLowerCase();
  }).filter(Boolean)));
  const { data: sharedContacts } = sharedEmails.length
    ? await supabase.from('registration_contacts').select('id,full_name,cpf,email,user_id').eq('organization_id', organization.id).in('email', sharedEmails)
    : { data: [] as Array<{ id: string; full_name: string | null; cpf: string | null; email: string | null; user_id: string | null }> };

  return <section className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">Revisões pendentes</h1>
        <p className="text-sm text-slate-400">{rows.length} linha(s) aguardando decisão explícita de identidade, compra, CPF ou conta proprietária.</p>
      </div>
      <Link href="/importacoes" className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Voltar às importações</Link>
    </div>
    {reviewError ? <div className="rounded-2xl border border-rose-700 bg-rose-950/40 p-4 text-sm text-rose-200">Não foi possível concluir a decisão: {reviewError}</div> : null}
    {rows.map((row) => {
      const imported = row.normalized_data as Record<string, unknown>;
      const details = row.identity_match_details as {
        reason?: string;
        candidates?: Candidate[];
        owner_candidates?: Candidate[];
        account_review?: string;
        excel_cpf?: { original?: string; suggested?: string };
      };
      const importedEmail = String(imported.email ?? '').trim().toLowerCase();
      const liveShared = (sharedContacts ?? [])
        .filter((contact) => String(contact.email ?? '').trim().toLowerCase() === importedEmail)
        .map((contact) => ({
          registration_contact_id: contact.id,
          full_name: contact.full_name ?? '',
          cpf: contact.cpf ?? '',
          email: contact.email ?? '',
          reason: 'shared_email',
        }));
      const candidates = [
        ...(details?.candidates ?? []),
        ...(details?.owner_candidates ?? []),
        ...liveShared,
      ].filter((candidate, index, all) => {
        const id = String(candidate.registration_contact_id ?? '');
        return id && all.findIndex((item) => String(item.registration_contact_id ?? '') === id) === index;
      });
      const hasExistingCpf = importRowHasExistingCpfIdentity(details, String(imported.cpf ?? imported.cpf_input ?? ''));
      const batch = Array.isArray(row.import_batches) ? row.import_batches[0] : row.import_batches;
      const event = batch && (Array.isArray(batch.events) ? batch.events[0] : batch.events);
      const reason = details?.reason ?? '';
      const suggestedCpf = String(row.cpf_excel_candidate ?? details?.excel_cpf?.suggested ?? '');
      const originalCpf = String(details?.excel_cpf?.original ?? imported.cpf_input ?? '');
      return <article key={row.id} className="rounded-3xl border border-amber-700/50 bg-slate-900/80 p-5">
        <div className="flex flex-wrap justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-amber-300">Linha {row.row_number} · {batch?.file_name}</p>
            <h2 className="mt-1 text-lg font-semibold">{String(imported.full_name ?? 'Sem nome')}</h2>
            <p className="text-xs text-slate-400">{event?.name ?? 'Evento'} · batch {String(row.import_batch_id).slice(0, 8)}</p>
          </div>
          <span className="h-fit rounded-full bg-amber-400/15 px-3 py-1 text-xs text-amber-200">{labels[reason] ?? row.error_message}</span>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-700 p-4">
            <h3 className="font-medium">Linha importada</h3>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <dt className="text-slate-500">Nome</dt><dd>{String(imported.full_name ?? '-')}</dd>
              <dt className="text-slate-500">CPF</dt><dd>{maskCpf(String(imported.cpf ?? imported.cpf_input ?? ''))}</dd>
              <dt className="text-slate-500">E-mail</dt><dd>{String(imported.email ?? '-')}</dd>
              <dt className="text-slate-500">Telefone</dt><dd>{String(imported.phone ?? '-')}</dd>
              <dt className="text-slate-500">Nascimento</dt><dd>{String(imported.birth_date ?? '-')}</dd>
              <dt className="text-slate-500">Camiseta</dt><dd>{[imported.shirt_type, imported.shirt_size].filter(Boolean).join(' ') || '-'}</dd>
            </dl>
          </div>
          <div className="space-y-3">
            <h3 className="font-medium">Candidatos encontrados</h3>
            {candidates.map((candidate) => (
              <div key={`${candidate.registration_contact_id}-${candidate.reason}`} className="rounded-2xl border border-slate-700 p-4 text-sm">
                <p className="font-semibold">{candidate.full_name || 'Cadastro sem nome'}</p>
                <p className="text-xs text-emerald-300">{labels[candidate.reason ?? ''] ?? candidate.reason}</p>
                <p className="mt-2 text-slate-400">CPF: {maskCpf(candidate.cpf ?? '')} · E-mail: {candidate.email || '-'}</p>
                {reason !== 'possible_reimport' && reason !== 'excel_leading_zero' ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <form action={submitReview}>
                      <input type="hidden" name="row_id" value={row.id}/>
                      <input type="hidden" name="filter_batch_id" value={batchId ?? ''}/>
                      <input type="hidden" name="decision" value="link_existing"/>
                      <input type="hidden" name="registration_contact_id" value={candidate.registration_contact_id}/>
                      <button className="rounded-xl bg-emerald-400 px-4 py-2 font-semibold text-emerald-950">É a mesma pessoa / vincular compra a esta Pessoa</button>
                    </form>
                    <form action={submitReview}>
                      <input type="hidden" name="row_id" value={row.id}/>
                      <input type="hidden" name="filter_batch_id" value={batchId ?? ''}/>
                      <input type="hidden" name="decision" value="assign_owner_contact"/>
                      <input type="hidden" name="owner_registration_contact_id" value={candidate.registration_contact_id}/>
                      <button className="rounded-xl border border-emerald-500 px-4 py-2 text-sm text-emerald-200">Usar esta Pessoa como conta dos ingressos</button>
                    </form>
                  </div>
                ) : null}
              </div>
            ))}
            {!candidates.length ? <p className="text-sm text-slate-500">Nenhum cadastro candidato além desta linha.</p> : null}
          </div>
        </div>

        {reason === 'excel_leading_zero' ? (
          <div className="mt-4 rounded-2xl border border-amber-700/40 p-4 text-sm">
            <p className="font-medium text-amber-200">Possível zero inicial removido pelo Excel</p>
            <p className="mt-1 text-slate-300">Original: {originalCpf || '10 dígitos'} · Sugestão: {suggestedCpf}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <form action={submitReview}>
                <input type="hidden" name="row_id" value={row.id}/>
                <input type="hidden" name="filter_batch_id" value={batchId ?? ''}/>
                <input type="hidden" name="decision" value="confirm_excel_cpf"/>
                <button className="rounded-xl bg-emerald-400 px-4 py-2 font-semibold text-emerald-950">Confirmar CPF sugerido</button>
              </form>
              <form action={submitReview} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="row_id" value={row.id}/>
                <input type="hidden" name="filter_batch_id" value={batchId ?? ''}/>
                <input type="hidden" name="decision" value="provide_alternate_cpf"/>
                <label className="text-xs text-slate-400">Informar outro CPF
                  <input name="cpf" className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" placeholder="000.000.000-00"/>
                </label>
                <button className="rounded-xl border border-sky-600 px-4 py-2 text-sky-200">Usar este CPF</button>
              </form>
              <form action={submitReview}>
                <input type="hidden" name="row_id" value={row.id}/>
                <input type="hidden" name="filter_batch_id" value={batchId ?? ''}/>
                <input type="hidden" name="decision" value="keep_pending_cpf"/>
                <button className="rounded-xl border border-amber-600 px-4 py-2 text-amber-200">Manter como CPF pendente</button>
              </form>
            </div>
          </div>
        ) : null}

        {reason === 'possible_reimport' ? (
          <div className="mt-4 flex flex-wrap gap-3">
            <form action={submitReview}>
              <input type="hidden" name="row_id" value={row.id}/>
              <input type="hidden" name="filter_batch_id" value={batchId ?? ''}/>
              <input type="hidden" name="decision" value="confirm_new_purchase"/>
              <button className="rounded-xl bg-emerald-400 px-4 py-2 font-semibold text-emerald-950">Esta é nova compra</button>
            </form>
            <form action={submitReview}>
              <input type="hidden" name="row_id" value={row.id}/>
              <input type="hidden" name="filter_batch_id" value={batchId ?? ''}/>
              <input type="hidden" name="decision" value="ignore_technical_duplicate"/>
              <button className="rounded-xl border border-rose-800 px-4 py-2 text-rose-300">Já foi importada / ignorar duplicação técnica</button>
            </form>
          </div>
        ) : null}

        <div className="mt-4 rounded-2xl bg-slate-950/60 p-3 text-xs text-slate-400">
          {hasExistingCpf
            ? 'Este CPF já identifica um cadastro. Vincular reutiliza essa Pessoa e cria a compra adicional. Não é possível criar outra Pessoa com o mesmo CPF. A decisão fica registrada em auditoria.'
            : 'Vincular reutiliza o cadastro e preserva a compra. Criar nova Pessoa só se o CPF ainda não existe. E-mail compartilhado não funde Pessoas: escolha a conta proprietária dos ingressos ou mantenha contas separadas. Ignorar encerra a linha sem criar pedido. A decisão fica registrada em auditoria.'}
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          {reason === 'excel_leading_zero' || reason === 'possible_reimport' ? null : (
            <>
              {hasExistingCpf ? null : (
                <form action={submitReview}>
                  <input type="hidden" name="row_id" value={row.id}/>
                  <input type="hidden" name="filter_batch_id" value={batchId ?? ''}/>
                  <input type="hidden" name="decision" value="create_new"/>
                  <button className="rounded-xl border border-sky-600 px-4 py-2 text-sm text-sky-200">É outra pessoa / criar nova Pessoa</button>
                </form>
              )}
              <form action={submitReview}>
                <input type="hidden" name="row_id" value={row.id}/>
                <input type="hidden" name="filter_batch_id" value={batchId ?? ''}/>
                <input type="hidden" name="decision" value="keep_people_separate"/>
                <button className="rounded-xl border border-slate-500 px-4 py-2 text-sm text-slate-200">Manter Pessoas separadas</button>
              </form>
            </>
          )}
          <form action={submitReview}>
            <input type="hidden" name="row_id" value={row.id}/>
            <input type="hidden" name="filter_batch_id" value={batchId ?? ''}/>
            <input type="hidden" name="decision" value="ignore"/>
            <button className="rounded-xl border border-rose-800 px-4 py-2 text-sm text-rose-300">Ignorar linha</button>
          </form>
          <Link href={`/importacoes?batchId=${row.import_batch_id}`} className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Abrir e reprocessar batch</Link>
        </div>
      </article>;
    })}
    {!rows.length ? <div className="rounded-3xl border border-dashed border-slate-700 p-10 text-center text-slate-400">Nenhuma revisão pendente.</div> : null}
  </section>;
}
