import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatDateBR } from '@/lib/utils/date';
import type { PublicBenefit, PublicCategory, PublicKitItem } from '@/lib/public/events';
import { getPublicEventDetails, isEventOpen } from '@/lib/public/events';

type Params = Promise<{ eventSlug: string }>;

export default async function EventDetailsPage({ params }: { params: Params }) {
  const { eventSlug } = await params;
  const { status, event, categories, benefitsByCategory, kitItems, queryError } = await getPublicEventDetails(eventSlug);

  if (status === 'query_error') {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
        <section className="mx-auto w-full max-w-3xl rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
          <h1 className="text-2xl font-semibold text-white">Falha ao carregar o evento</h1>
          <p className="mt-2 text-sm text-slate-300">
            Ocorreu um erro técnico ao consultar o evento por slug.
          </p>
          <p className="mt-2 text-xs text-slate-400">
            slug: {eventSlug} | erro: {queryError?.code ?? 'sem-codigo'} - {queryError?.message ?? 'erro desconhecido'}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/eventos" className="inline-flex h-10 items-center justify-center rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-emerald-950">
              Voltar aos eventos
            </Link>
            <Link href="/" className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-700 px-4 text-sm text-slate-100">
              Ir para início
            </Link>
          </div>
        </section>
      </main>
    );
  }

  if (!event) {
    notFound();
  }

  const open = isEventOpen(event);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-5xl space-y-4">
        <article className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{event.year ?? 'Edicao especial'}</p>
          <h1 className="mt-2 text-3xl font-semibold text-white">{event.name}</h1>
          <p className="mt-3 text-sm text-slate-300">{event.description ?? 'Detalhes completos deste evento serao publicados em breve.'}</p>
          <div className="mt-4 grid gap-2 text-sm text-slate-300 sm:grid-cols-3">
            <p>{event.startsAt ? formatDateBR(event.startsAt) : 'Data a confirmar'}</p>
            <p>{event.location ?? 'Local a confirmar'}</p>
            <p>{open ? 'Inscricoes abertas' : 'Inscricoes fechadas'}</p>
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href={`/inscricao/${event.slug}`} className="inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300">
              Comprar ingresso
            </Link>
            <Link href="/eventos" className="inline-flex h-11 items-center justify-center rounded-2xl border border-slate-700 px-5 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:text-white">
              Ver outros eventos
            </Link>
          </div>
        </article>

        <article className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
          <h2 className="text-xl font-semibold text-white">Categorias</h2>
          <div className="mt-4 space-y-3">
            {categories.length === 0 ? (
              <p className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">Categorias ainda nao publicadas.</p>
            ) : (
              categories.map((category: PublicCategory) => (
                <div key={category.id} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-sm font-semibold text-slate-100">{category.name}</p>
                  <p className="mt-1 text-xs text-slate-400">{category.description ?? 'Sem descricao.'}</p>
                  {category.availableSlots !== null ? <p className="mt-1 text-xs text-slate-400">Vagas disponiveis: {category.availableSlots}</p> : null}
                  <ul className="mt-2 space-y-1 text-xs text-slate-300">
                    {(benefitsByCategory[category.id] ?? []).map((benefit: PublicBenefit) => (
                      <li key={benefit.id}>• {benefit.name}</li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>
        </article>

        {kitItems.length > 0 ? (
          <article className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
            <h2 className="text-xl font-semibold text-white">Kit do participante</h2>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {kitItems.map((item: PublicKitItem) => (
                <div key={item.id} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
                  <p className="font-medium text-slate-100">{item.name}</p>
                  <p className="mt-1 text-xs text-slate-400">{item.description ?? 'Item sem descricao.'}</p>
                </div>
              ))}
            </div>
          </article>
        ) : null}
      </section>
    </main>
  );
}
