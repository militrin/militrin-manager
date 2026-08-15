import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateTimeBR } from '@/lib/utils/date';
import { getAccessibleTicketScope, getAccountOrders } from '@/lib/account/portal-orders-and-tickets';
import { getAccountEventSchedule } from '@/lib/account/event-schedule';

export default async function MinhaContaCronogramaPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  const ordersResult = await getAccountOrders(supabase, user?.id ?? '');
  const scope = await getAccessibleTicketScope(
    supabase,
    user?.id ?? '',
    (ordersResult.data ?? []) as Array<Record<string, unknown>>,
  );
  const scheduleResult = scope.error
    ? { data: [], error: scope.error }
    : await getAccountEventSchedule(supabase, scope.ownedEventIds, { includePast: true });
  const upcomingResult = scope.error
    ? { data: [], error: scope.error }
    : await getAccountEventSchedule(supabase, scope.ownedEventIds);

  if (ordersResult.error || scheduleResult.error || upcomingResult.error) {
    console.error('[minha-conta/entregas] erro ao carregar cronograma', ordersResult.error ?? scheduleResult.error ?? upcomingResult.error);
    return <ScheduleShell><p className="text-sm text-rose-200">Não foi possível carregar o cronograma agora. Tente novamente.</p></ScheduleShell>;
  }

  const upcoming = upcomingResult.data;
  const upcomingIds = new Set(upcoming.map((item) => item.id));
  const past = scheduleResult.data.filter((item) => !upcomingIds.has(item.id)).reverse();

  return (
    <ScheduleShell>
      {scheduleResult.data.length === 0 ? (
        <p className="text-sm text-slate-300">Nenhum compromisso disponível para os eventos dos seus ingressos.</p>
      ) : (
        <div className="space-y-7">
          <ScheduleGroup title="Próximos compromissos" rows={upcoming} />
          <ScheduleGroup title="Compromissos anteriores" rows={past} />
        </div>
      )}
    </ScheduleShell>
  );
}

function ScheduleShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow),transparent_35%),linear-gradient(180deg,#020617,#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-4xl rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div><p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Minha conta</p><h1 className="text-2xl font-semibold text-white">Cronograma dos seus eventos</h1></div>
          <Link href="/minha-conta" className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-700 px-4 text-sm text-slate-100">Voltar para Minha conta</Link>
        </div>
        {children}
      </section>
    </main>
  );
}

function ScheduleGroup({ title, rows }: { title: string; rows: Awaited<ReturnType<typeof getAccountEventSchedule>>['data'] }) {
  if (rows.length === 0) return null;
  return <section><h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.15em] text-slate-400">{title}</h2><div className="space-y-3">{rows.map((item) => (
    <article key={item.id} className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.15em] text-emerald-300">{item.event_name}</p>
      <p className="mt-1 text-base font-semibold text-white">{item.title}</p>
      <p className="mt-1 text-sm text-slate-200">{formatDateTimeBR(item.delivery_at, ' às ')}</p>
      {item.location ? <p className="text-sm text-slate-300">{item.location}</p> : null}
      {item.description ? <p className="mt-2 text-sm text-slate-400">{item.description}</p> : null}
    </article>
  ))}</div></section>;
}
