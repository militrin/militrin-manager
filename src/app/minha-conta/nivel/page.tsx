import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getLoyaltyLevel, getLoyaltyProgress, normalizeLoyaltyLevel, sortLoyaltyLevels } from '@/lib/account/levels';

const LEVEL_GUIDE = ['Bronze', 'Prata', 'Ouro', 'Diamante', 'Legend Militrin'];

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

      <div className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-6 shadow-lg shadow-black/10">
        <p className="text-xs uppercase tracking-[0.22em] text-emerald-300">Sistema de categoria</p>
        <h3 className="mt-2 text-2xl font-semibold text-white">Bronze, Prata, Ouro, Diamante e Legend Militrin</h3>
        <p className="mt-2 text-sm text-slate-300">A progressão oficial do portal segue sempre esta ordem.</p>

        <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {LEVEL_GUIDE.map((label) => {
            const isCurrent = currentLevel.name.toLowerCase() === label.toLowerCase();
            return (
              <div key={label} className={`rounded-2xl border px-4 py-3 text-sm ${isCurrent ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-100' : 'border-slate-800 bg-slate-950/60 text-slate-300'}`}>
                <p className="font-medium">{label}</p>
                <p className="mt-1 text-xs opacity-80">{isCurrent ? 'Nível atual' : 'Categoria disponível'}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}