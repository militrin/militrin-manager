import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getLoyaltyLevel, getLoyaltyProgress, normalizeLoyaltyLevel, sortLoyaltyLevels } from '@/lib/account/levels';

export default async function NivelPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [ordersResult, tiersResult] = await Promise.all([
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('user_id', user?.id ?? '').eq('status', 'confirmed'),
    supabase.from('loyalty_tiers').select('id, slug, name, badge, min_confirmed_participations, sort_order').order('min_confirmed_participations', { ascending: true }).order('sort_order', { ascending: true }),
  ]);

  const loyaltyLevels = sortLoyaltyLevels((tiersResult.data ?? []).map((level) => normalizeLoyaltyLevel(level as Record<string, unknown>)));
  const confirmedParticipations = Number(ordersResult.count ?? 0);
  const currentLevel = getLoyaltyLevel(confirmedParticipations, loyaltyLevels);
  const progress = getLoyaltyProgress(confirmedParticipations, loyaltyLevels);

  return (
    <section className="space-y-5">
      <div className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-6 shadow-lg shadow-black/10">
        <p className="text-xs uppercase tracking-[0.22em] text-emerald-300">Meu nível</p>
        <h2 className="mt-2 text-3xl font-semibold text-white">{currentLevel.name}</h2>
        <p className="mt-2 text-sm text-slate-300">Participações confirmadas: {confirmedParticipations}</p>
        <p className="mt-2 text-sm text-slate-300">Badge atual: {currentLevel.badge}</p>

        <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Progresso</p>
              <p className="mt-2 text-sm text-slate-200">
                {progress.completed ? 'Você alcançou o nível máximo do Militrin.' : `Faltam ${progress.remaining} participações confirmadas para chegar ao ${String(progress.next?.name ?? '')}.`}
              </p>
            </div>
            <span className="rounded-full border border-emerald-500/40 px-3 py-1 text-xs uppercase tracking-wide text-emerald-200">{Math.round(progress.progress)}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
            <div className="h-full rounded-full bg-emerald-400" style={{ width: `${progress.progress}%` }} />
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {loyaltyLevels.map((level) => {
          const active = level.slug === currentLevel.slug;
          return (
            <article key={level.slug} className={`rounded-[1.75rem] border p-5 ${active ? 'border-emerald-400/40 bg-emerald-400/10' : 'border-slate-800 bg-slate-950/60'}`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{level.badge}</p>
                  <h3 className="mt-2 text-xl font-semibold text-white">{level.name}</h3>
                </div>
                <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">{level.minConfirmedParticipations}+</span>
              </div>
              <p className="mt-3 text-sm text-slate-300">{active ? 'Nível atual' : 'Nível disponível no portal'}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}