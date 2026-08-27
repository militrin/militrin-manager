import Link from 'next/link';
import { redirect } from 'next/navigation';
import { MilitrinEventArtwork } from '@/components/militrin';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';

function isEventOpen(event: { registration_open_at: string | null; registration_close_at: string | null; registration_enabled: boolean }) {
  if (!event.registration_enabled) return false;
  const now = Date.now();
  const openOk = !event.registration_open_at || new Date(event.registration_open_at).getTime() <= now;
  const closeOk = !event.registration_close_at || new Date(event.registration_close_at).getTime() >= now;
  return openOk && closeOk;
}

export default async function ComprarPage() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('events')
    .select('id, name, slug, description, starts_at, ends_at, location, registration_enabled, registration_open_at, registration_close_at, banner_card_url')
    .eq('registration_enabled', true)
    .order('starts_at', { ascending: true, nullsFirst: false });

  if (error) throw error;

  const openEvents = (data ?? []).filter((event) => isEventOpen(event));

  if (openEvents.length === 1) {
    redirect(`/inscricao/${openEvents[0].slug}`);
  }

  return (
    <section className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-6 shadow-lg shadow-black/10">
      <p className="text-xs uppercase tracking-[0.22em] text-emerald-300">Comprar</p>
      <h2 className="mt-2 text-3xl font-semibold text-white">Escolha um evento</h2>
      <p className="mt-2 max-w-2xl text-sm text-slate-300">As vendas abertas aparecem abaixo. Se houver apenas um evento disponível, o sistema segue direto para a compra.</p>

      {openEvents.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/60 p-5 text-sm text-slate-300">
          Nenhum evento com vendas abertas no momento.
        </div>
      ) : (
        <div className="mt-6 grid gap-4">
          {openEvents.map((event) => {
            const startsAt = event.starts_at ? formatDateBR(event.starts_at) : 'Data a definir';
            const endsAt = event.ends_at ? formatDateBR(event.ends_at) : null;

            return (
              <article key={event.id} className="overflow-hidden rounded-[1.75rem] border border-slate-800 bg-slate-950/60">
                <Link href={`/eventos/${event.slug}`} className="block transition hover:bg-slate-900/60">
                  <MilitrinEventArtwork src={event.banner_card_url} hideWhenEmpty />
                  <div className="space-y-2 p-5 pb-0">
                    <h3 className="text-xl font-semibold text-white">{event.name}</h3>
                    <p className="text-sm text-slate-300">{event.description ?? 'Sem descrição.'}</p>
                    <p className="text-sm text-slate-400">
                      {startsAt}
                      {endsAt ? ` até ${endsAt}` : ''}
                    </p>
                    <p className="text-sm text-slate-400">{event.location ?? 'Local a confirmar'}</p>
                    <p className="text-xs font-medium uppercase tracking-wide text-emerald-300">Vendas abertas · toque para ver todas as infos</p>
                  </div>
                </Link>
                <div className="flex justify-end p-5">
                  <Link href={`/inscricao/${event.slug}`} className="inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300">
                    Continuar compra
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
