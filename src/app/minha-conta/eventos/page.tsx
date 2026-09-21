import { getPublicEvents } from '@/lib/public/events';
import { presentPublicEventDiscovery } from '@/lib/public/event-discovery';
import { AccountEventDiscoveryGrid } from './event-discovery-grid';

export default async function AccountEventsPage() {
  const { events } = await getPublicEvents();
  const cards = events.map((event) => presentPublicEventDiscovery(event));

  return (
    <section className="space-y-4">
      <header className="rounded-[1.75rem] border border-slate-800/80 bg-slate-900/70 p-5 sm:p-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-300">Eventos</p>
        <h1 className="mt-2 text-2xl font-semibold text-white sm:text-3xl">Eventos Militrin</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-300">
          Veja os eventos disponíveis. Vendas abertas permitem compra; eventos ativos com vendas fechadas continuam visíveis.
        </p>
      </header>
      <AccountEventDiscoveryGrid events={cards} />
    </section>
  );
}
