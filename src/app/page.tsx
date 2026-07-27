import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';
import { getPublicEvents, isEventOpen } from '@/lib/public/events';

export default async function Home() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { events } = await getPublicEvents();
  const featuredEvents = events.slice(0, 3);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-6xl rounded-[2rem] border border-slate-800/70 bg-slate-950/65 p-6 shadow-2xl shadow-black/20 sm:p-10">
        <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
          <div className="space-y-5">
            <p className="inline-flex rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-1 text-xs uppercase tracking-[0.2em] text-emerald-200">Militrin</p>
            <h1 className="text-3xl font-semibold text-white sm:text-5xl">Sua jornada começa aqui.</h1>
            <p className="max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
              Conheca os eventos, explore categorias e escolha sua experiencia. O cadastro e login sao exigidos apenas na hora de comprar e acessar sua conta.
            </p>
            <div className="flex flex-wrap gap-3">
              <Link href="/eventos" className="inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300">
                Ver eventos
              </Link>
              <Link href={user ? '/minha-conta' : '/entrar'} className="inline-flex h-11 items-center justify-center rounded-2xl border border-slate-700 px-5 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:text-white">
                {user ? 'Ir para minha conta' : 'Entrar'}
              </Link>
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
            <h2 className="text-lg font-semibold text-white">Proximos eventos</h2>
            <div className="mt-4 space-y-3">
              {featuredEvents.length === 0 ? (
                <p className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-400">Novos eventos serao publicados em breve.</p>
              ) : (
                featuredEvents.map((event) => (
                  <Link key={event.id} href={`/eventos/${event.slug}`} className="block rounded-2xl border border-slate-800 bg-slate-950/70 p-4 transition hover:border-emerald-500/40">
                    <p className="text-sm font-semibold text-slate-100">{event.name}</p>
                    <p className="mt-1 text-xs text-slate-400">{event.startsAt ? formatDateBR(event.startsAt) : 'Data a confirmar'}</p>
                    <p className="mt-1 text-xs text-slate-400">{isEventOpen(event) ? 'Inscricoes abertas' : 'Inscricoes fechadas'}</p>
                  </Link>
                ))
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}