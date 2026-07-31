import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateTimeBR } from '@/lib/utils/date';

export default async function MinhaContaEntregasPage() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_upcoming_kit_deliveries', { p_limit: 100 });

  if (error) {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.16),transparent_35%),linear-gradient(180deg,#020617,#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
        <section className="mx-auto w-full max-w-4xl rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
          <h1 className="text-2xl font-semibold text-white">Cronograma de entregas</h1>
          <p className="mt-2 text-sm text-slate-300">Não foi possível carregar as entregas agora. Tente novamente.</p>
          <Link href="/minha-conta" className="mt-5 inline-flex h-10 items-center justify-center rounded-xl border border-slate-700 px-4 text-sm text-slate-100">
            Voltar para Minha conta
          </Link>
        </section>
      </main>
    );
  }

  const rows = ((data ?? []) as Array<{
    id: string;
    delivery_at: string;
    city: string;
    location: string;
    sort_order: number;
  }>).map((item) => ({
    id: String(item.id),
    delivery_at: String(item.delivery_at),
    city: String(item.city ?? ''),
    location: String(item.location ?? ''),
    sort_order: Number(item.sort_order ?? 0),
  }));

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.16),transparent_35%),linear-gradient(180deg,#020617,#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-4xl rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold text-white">Cronograma de entregas</h1>
          <Link href="/minha-conta" className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-700 px-4 text-sm text-slate-100">
            Voltar para Minha conta
          </Link>
        </div>

        {rows.length === 0 ? (
          <p className="mt-4 text-sm text-slate-300">Nenhuma entrega de kits programada no momento.</p>
        ) : (
          <div className="mt-4 space-y-3">
            {rows.map((item) => (
              <article key={item.id} className="rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
                <p className="text-base font-semibold text-white">{formatDateTimeBR(item.delivery_at, ' às ')}</p>
                <p className="mt-1 text-sm text-slate-200">{item.city}</p>
                <p className="text-sm text-slate-300">{item.location}</p>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
