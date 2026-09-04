import { Sidebar } from '@/components/dashboard/Sidebar';
import { TopBar } from '@/components/dashboard/TopBar';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { hasPermission } from '@/lib/admin/permissions';
import { getCurrentOrganizationContext } from '@/lib/organizations/current-organization';
import { ImportacoesClient } from './ImportacoesClient';
import Link from 'next/link';

async function getEvents(organizationId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('events')
    .select('id, name, year')
    .eq('organization_id', organizationId)
    .order('starts_at', { ascending: false, nullsFirst: false });

  if (error) throw error;

  return (data ?? []).map((event) => ({
    id: String(event.id),
    name: String(event.name),
    year: event.year === null || event.year === undefined ? null : Number(event.year),
  }));
}

async function getImportOptions(organizationId: string) {
  const supabase = await createServerSupabaseClient();
  const { data: orgEvents } = await supabase.from('events').select('id').eq('organization_id', organizationId);
  const eventIds = (orgEvents ?? []).map((event) => String(event.id));
  if (!eventIds.length) return { categories: [], batches: [], prices: [] };

  const [{ data: categories }, { data: batches }] = await Promise.all([
    supabase.from('ticket_categories').select('id,event_id,name,is_active').eq('is_active', true).in('event_id', eventIds).order('name'),
    supabase.from('registration_batches').select('id,event_id,name,is_active').eq('is_active', true).in('event_id', eventIds).order('starts_at'),
  ]);
  const batchIds = (batches ?? []).map((batch) => String(batch.id));
  const { data: prices } = batchIds.length
    ? await supabase.from('registration_batch_prices').select('batch_id,ticket_category_id').in('batch_id', batchIds)
    : { data: [] };
  return { categories: categories ?? [], batches: batches ?? [], prices: prices ?? [] };
}

export default async function ImportacoesPage({ searchParams }: { searchParams: Promise<{ batchId?: string }> }) {
  const { batchId } = await searchParams;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/entrar?next=/importacoes');
  }

  const currentOrganization = (await getCurrentOrganizationContext()).organization;
  if (!currentOrganization?.id) {
    redirect('/painel');
  }

  const [events, canConfirmPayment, canManageInvites, importOptions, pendingReviews, recentBatches] = await Promise.all([
    getEvents(currentOrganization.id),
    hasPermission('finance.confirm_payment'),
    hasPermission('participants.edit_basic'),
    getImportOptions(currentOrganization.id),
    supabase.from('import_batch_rows').select('id,import_batches!inner(organization_id)', { count: 'exact', head: true })
      .eq('status', 'review_required').eq('resolution', 'pending').eq('import_batches.organization_id', currentOrganization.id),
    supabase.from('import_batches')
      .select('id,file_name,import_type,status,imported_rows,created_at')
      .eq('organization_id', currentOrganization.id)
      .in('status', ['completed', 'ready_for_review'])
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow-strong),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Importações" subtitle="Histórico e inscritos atuais com validação e idempotência" />
          <div className="flex justify-end"><Link href="/importacoes/revisoes" className="rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-amber-950">Revisões pendentes ({pendingReviews.count ?? 0})</Link></div>
          {(recentBatches.data ?? []).length ? (
            <SectionCard title="Lotes recentes" description="Reabra uma importação já processada para gerenciar convites ou continuar revisões. O painel não depende do relatório em memória.">
              <div className="space-y-2">
                {(recentBatches.data ?? []).map((batch) => (
                  <div key={String(batch.id)} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/50 px-4 py-3 text-sm">
                    <div>
                      <p className="font-medium text-slate-100">{batch.file_name || 'Importação sem arquivo'}</p>
                      <p className="text-xs text-slate-400">{String(batch.status)} · {Number(batch.imported_rows ?? 0)} importado(s) · {batch.created_at ? new Date(String(batch.created_at)).toLocaleString('pt-BR') : ''}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link href={`/importacoes?batchId=${encodeURIComponent(String(batch.id))}`} className="rounded-xl border border-slate-600 px-3 py-2">Reabrir lote</Link>
                      {batch.status === 'completed' && canManageInvites ? (
                        <Link href={`/importacoes?batchId=${encodeURIComponent(String(batch.id))}`} className="rounded-xl bg-cyan-400 px-3 py-2 font-semibold text-cyan-950">Gerenciar convites</Link>
                      ) : null}
                      {batch.status === 'ready_for_review' ? (
                        <Link href={`/importacoes/revisoes?batchId=${encodeURIComponent(String(batch.id))}`} className="rounded-xl border border-amber-500 px-3 py-2 text-amber-100">Abrir revisões</Link>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </SectionCard>
          ) : null}
          <SectionCard title="Módulo de importação" description="CSV/XLSX com prévia, revisão de duplicidade e relatório final.">
            <ImportacoesClient events={events} importOptions={importOptions} canConfirmPayment={canConfirmPayment} canManageInvites={canManageInvites} initialBatchId={batchId} />
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
