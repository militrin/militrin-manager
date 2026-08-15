import Link from 'next/link';
import { formatDateBR } from '@/lib/utils/date';
import { getPublicEvents, isEventOpen } from '@/lib/public/events';

export default async function EventsPage() {
  const { events } = await getPublicEvents();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-6xl space-y-4">
        <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
          <Link href="/" className="inline-flex h-9 items-center rounded-xl border border-slate-700 px-3 text-xs text-slate-300 transition hover:border-slate-500 hover:text-white">
            ← Início
          </Link>
          <h1 className="mt-4 text-3xl font-semibold text-white">Eventos Militrin</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-300">Navegue pelos eventos, conheca categorias e beneficios, e siga para inscricao quando estiver pronto.</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {events.length === 0 ? (
            <p className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">Nenhum evento publicado no momento.</p>
          ) : (
            events.map((event) => (
              <Link
                key={event.id}
                href={`/eventos/${event.slug}`}
                className="block overflow-hidden rounded-3xl border border-slate-800/80 bg-slate-900/70 transition hover:border-emerald-500/40"
              >
                {event.bannerCardUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={event.bannerCardUrl} alt="" className="h-40 w-full object-cover" />
                ) : null}
                <div className="p-5">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{event.year ?? 'Edicao especial'}</p>
                <h2 className="mt-2 text-xl font-semibold text-white">{event.name}</h2>
                <p className="mt-2 line-clamp-3 text-sm text-slate-300">{event.description ?? 'Mais detalhes em breve.'}</p>
                <div className="mt-4 space-y-1 text-xs text-slate-400">
                  <p>{event.startsAt ? formatDateBR(event.startsAt) : 'Data a confirmar'}</p>
                  <p>{event.location ?? 'Local a confirmar'}</p>
                  <p>{isEventOpen(event) ? 'Inscricoes abertas' : 'Inscricoes fechadas'}</p>
                </div>
                <span className="mt-4 inline-flex h-10 items-center rounded-xl border border-emerald-500/40 px-4 text-sm font-medium text-emerald-200">
                  Ver detalhes
                </span>
                </div>
              </Link>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
