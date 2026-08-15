import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';
import { getPublicEvents, isEventOpen } from '@/lib/public/events';
import { HomeLoginForm } from './home-login-form';

export default async function Home() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect('/minha-conta');
  }

  const { events } = await getPublicEvents();
  const featuredEvents = events.slice(0, 3);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-6xl rounded-[2rem] border border-slate-800/70 bg-slate-950/65 p-6 shadow-2xl shadow-black/20 sm:p-10">
        <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-start">
          <div className="space-y-5">
            <p className="inline-flex rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-1 text-xs uppercase tracking-[0.2em] text-emerald-200">Grupo Militrin</p>
            <h1 className="text-3xl font-semibold text-white sm:text-5xl">Prepare o caneco: viva a Oktoberfest com o Militrin!</h1>
            <p className="max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
              Garanta seu pacote de forma rápida, sem complicação e 100% online.
            </p>
            <Link href="/eventos" className="inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300">
              Ver eventos
            </Link>

            <div>
              <h2 className="mb-3 text-lg font-semibold text-white">Proximos eventos</h2>
              <div className="space-y-3">
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

          <HomeLoginForm />
        </div>
      </section>
    </main>
  );
}