import { Sidebar } from '@/components/dashboard/Sidebar';
import { TopBar } from '@/components/dashboard/TopBar';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { hasPermission } from '@/lib/admin/permissions';
import { ImportacoesClient } from './ImportacoesClient';

async function getEvents() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('events')
    .select('id, name, year')
    .order('starts_at', { ascending: false, nullsFirst: false });

  if (error) throw error;

  return (data ?? []).map((event) => ({
    id: String(event.id),
    name: String(event.name),
    year: event.year === null || event.year === undefined ? null : Number(event.year),
  }));
}

async function getImportOptions() {
  const supabase = await createServerSupabaseClient();
  const [{ data: categories }, { data: batches }, { data: prices }] = await Promise.all([
    supabase.from('ticket_categories').select('id,event_id,name,is_active').eq('is_active', true).order('name'),
    supabase.from('registration_batches').select('id,event_id,name,is_active').eq('is_active', true).order('starts_at'),
    supabase.from('registration_batch_prices').select('batch_id,ticket_category_id'),
  ]);
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

  const [events, canConfirmPayment, importOptions] = await Promise.all([
    getEvents(),
    hasPermission('finance.confirm_payment'),
    getImportOptions(),
  ]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow-strong),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Importações" subtitle="Histórico e inscritos atuais com validação e idempotência" />
          <SectionCard title="Módulo de importação" description="CSV/XLSX com prévia, revisão de duplicidade e relatório final.">
            <ImportacoesClient events={events} importOptions={importOptions} canConfirmPayment={canConfirmPayment} initialBatchId={batchId} />
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
