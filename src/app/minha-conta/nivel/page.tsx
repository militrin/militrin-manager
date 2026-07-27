import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';
import { getLoyaltyLevel, getLoyaltyProgress, normalizeLoyaltyLevel, sortLoyaltyLevels } from '@/lib/account/levels';
import { MilitrinBadge, MilitrinProgress, MilitrinSection, MilitrinStat } from '@/components/militrin';

const BENEFITS_BY_LEVEL: Record<string, string[]> = {
  bronze: ['Acesso ao portal do participante', 'Historico de compras e ingressos'],
  prata: ['Prioridade em novidades do evento', 'Reconhecimento no perfil do portal'],
  ouro: ['Maior destaque na comunidade Militrin', 'Convites para ativacoes especiais'],
  diamante: ['Experiencia premium no portal', 'Beneficios progressivos por participacao'],
  'legend-militrin': ['Nivel maximo da comunidade', 'Selo exclusivo Legend Militrin'],
};

function progressMessage(remaining: number, nextLevelName: string | null, completed: boolean) {
  if (completed) return 'Você alcançou o nível máximo do Militrin.';
  if (!nextLevelName) return 'Seu próximo nível será exibido quando houver nova faixa ativa.';
  return remaining === 1
    ? `Falta 1 participação oficial para chegar ao ${nextLevelName}.`
    : `Faltam ${remaining} participações oficiais para chegar ao ${nextLevelName}.`;
}

export default async function NivelPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [ordersResult, tiersResult, historyResult] = await Promise.all([
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('user_id', user?.id ?? '').eq('status', 'confirmed'),
    supabase.from('loyalty_tiers').select('id, slug, name, badge, min_confirmed_participations, sort_order').order('min_confirmed_participations', { ascending: true }).order('sort_order', { ascending: true }),
    supabase
      .from('orders')
      .select('id, created_at, confirmed_at, events(name)')
      .eq('user_id', user?.id ?? '')
      .eq('status', 'confirmed')
      .order('confirmed_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(8),
  ]);

  const loyaltyLevels = sortLoyaltyLevels((tiersResult.data ?? []).map((level) => normalizeLoyaltyLevel(level as Record<string, unknown>)));
  const confirmedParticipations = Number(ordersResult.count ?? 0);
  const currentLevel = getLoyaltyLevel(confirmedParticipations, loyaltyLevels);
  const progress = getLoyaltyProgress(confirmedParticipations, loyaltyLevels);
  const benefits = BENEFITS_BY_LEVEL[currentLevel.slug] ?? BENEFITS_BY_LEVEL.bronze;
  const history = historyResult.data ?? [];

  return (
    <section className="space-y-4">
      <MilitrinSection
        eyebrow="Minha categoria"
        title={String(currentLevel.name)}
        description={`Você possui ${confirmedParticipations} participações oficiais no Militrin.`}
        action={<MilitrinBadge tone="success">{String(currentLevel.badge)}</MilitrinBadge>}
      >
        <MilitrinProgress
          label="Progresso para proxima categoria"
          value={progress.progress}
          helper={progressMessage(progress.remaining, progress.next?.name ?? null, progress.completed)}
        />

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <MilitrinStat label="Participações oficiais" value={confirmedParticipations} />
          <MilitrinStat label="Nível atual" value={String(currentLevel.name)} />
          <MilitrinStat label="Badge" value={String(currentLevel.badge)} />
        </div>
      </MilitrinSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <MilitrinSection eyebrow="Histórico" title="Últimas participações" description="Pedidos confirmados mais recentes.">
          <div className="space-y-2">
            {history.length ? history.map((item) => {
              const eventObj = Array.isArray(item.events) ? item.events[0] : item.events;
              const dateRef = item.confirmed_at ?? item.created_at;
              return (
                <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm text-slate-200">
                  <p>{eventObj?.name ? String(eventObj.name) : 'Evento Militrin'}</p>
                  <p className="mt-1 text-xs text-slate-400">{dateRef ? formatDateBR(String(dateRef)) : '-'}</p>
                </div>
              );
            }) : (
              <p className="text-sm text-slate-300">Seu historico aparecera apos sua primeira participacao confirmada.</p>
            )}
          </div>
        </MilitrinSection>

        <MilitrinSection eyebrow="Beneficios" title="Vantagens do nivel" description="Conquistas liberadas para sua categoria atual.">
          <ul className="space-y-2 text-sm text-slate-200">
            {benefits.map((benefit) => (
              <li key={benefit} className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">{benefit}</li>
            ))}
          </ul>
        </MilitrinSection>
      </div>

      <MilitrinSection eyebrow="Mapa de niveis" title="Progressao oficial" description="Faixas usadas no portal do participante.">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {loyaltyLevels.map((level) => {
            const active = level.slug === currentLevel.slug;
            return (
              <article key={level.slug} className={`rounded-2xl border p-4 ${active ? 'border-emerald-400/50 bg-emerald-400/10' : 'border-slate-800 bg-slate-950/60'}`}>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">{String(level.badge)}</p>
                <h3 className="mt-2 text-lg font-semibold text-white">{String(level.name)}</h3>
                <p className="mt-2 text-xs text-slate-300">{level.minConfirmedParticipations}+ participações oficiais</p>
                <p className="mt-1 text-xs text-slate-400">{active ? 'Nivel atual' : 'Disponivel'}</p>
              </article>
            );
          })}
        </div>
      </MilitrinSection>
    </section>
  );
}
