import Link from 'next/link';
import Image from 'next/image';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';
import { getLoyaltyLevel, getLoyaltyProgress, normalizeLoyaltyLevel, sortLoyaltyLevels } from '@/lib/account/levels';

function isEventOpen(event: { registration_enabled: boolean; registration_open_at: string | null; registration_close_at: string | null }) {
  if (!event.registration_enabled) return false;

  const now = Date.now();
  const openOk = !event.registration_open_at || new Date(event.registration_open_at).getTime() <= now;
  const closeOk = !event.registration_close_at || new Date(event.registration_close_at).getTime() >= now;
  return openOk && closeOk;
}

function formatProgressMessage(remaining: number, nextLevelName: string | null, completed: boolean) {
  if (completed) {
    return 'Você alcançou o nível máximo do Militrin.';
  }

  if (!nextLevelName) {
    return 'Seu próximo nível será exibido assim que houver uma nova faixa configurada.';
  }

  return remaining === 1
    ? `Falta 1 participação confirmada para chegar ao ${nextLevelName}.`
    : `Faltam ${remaining} participações confirmadas para chegar ao ${nextLevelName}.`;
}

function formatMemberSince(value: string | null | undefined) {
  if (!value) return new Date().getFullYear();
  const year = new Date(value).getFullYear();
  return Number.isNaN(year) ? new Date().getFullYear() : year;
}

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

export default async function MinhaContaPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [profileResult, ordersResult, ticketsResult, eventsResult, tiersResult] = await Promise.all([
    supabase.rpc('get_customer_profile', { p_user_id: user?.id ?? null }),
    supabase
      .from('orders')
      .select('id, order_number, status, final_amount, created_at, confirmed_at, participant_id, participants(full_name), events(name), tickets(id, status, token)')
      .eq('user_id', user?.id ?? '')
      .order('created_at', { ascending: false }),
    supabase
      .from('tickets')
      .select('id, status, issued_at, order_id, orders!inner(user_id)')
      .eq('orders.user_id', user?.id ?? '')
      .order('issued_at', { ascending: false }),
    supabase
      .from('events')
      .select('id, name, slug, starts_at, ends_at, location, registration_enabled, registration_open_at, registration_close_at')
      .eq('registration_enabled', true)
      .order('starts_at', { ascending: true, nullsFirst: false }),
    supabase
      .from('loyalty_tiers')
      .select('id, slug, name, badge, min_confirmed_participations, sort_order')
      .order('min_confirmed_participations', { ascending: true })
      .order('sort_order', { ascending: true }),
  ]);

  const profile = (Array.isArray(profileResult.data) ? profileResult.data[0] : profileResult.data) as Record<string, unknown> | null;
  const loyaltyLevels = sortLoyaltyLevels((tiersResult.data ?? []).map((level) => normalizeLoyaltyLevel(level as Record<string, unknown>)));
  const orders = ordersResult.data ?? [];
  const openEvents = (eventsResult.data ?? []).filter((event) => isEventOpen(event));
  const activeTickets = (ticketsResult.data ?? []).filter((ticket) => String(ticket.status ?? '') === 'active');
  const confirmedParticipations = orders.filter((order) => order.status === 'confirmed').length;
  const pendingOrder = orders.find((order) => order.status === 'pending') ?? null;
  const latestConfirmedOrder = orders.find((order) => {
    if (order.status !== 'confirmed') return false;
    const ticket = Array.isArray(order.tickets) ? order.tickets[0] : order.tickets;
    return Boolean(ticket?.id);
  }) ?? null;
  const currentLevel = getLoyaltyLevel(confirmedParticipations, loyaltyLevels);
  const progress = getLoyaltyProgress(confirmedParticipations, loyaltyLevels);

  const greetingName = String(profile?.full_name ?? user?.email ?? 'Participante').split(' ')[0];
  const profilePhotoUrl = String((user?.user_metadata as Record<string, unknown> | undefined)?.avatar_url ?? '').trim();
  const greetingInitials = String(profile?.full_name ?? user?.email ?? 'Participante')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((chunk) => chunk[0]?.toUpperCase() ?? '')
    .join('');
  const nextEvent = openEvents[0] ?? null;
  const profileComplete = Boolean(
    String(profile?.full_name ?? '').trim()
    && String(profile?.cpf ?? '').trim()
    && String(profile?.birth_date ?? '').trim()
    && String(profile?.gender ?? '').trim()
    && String(profile?.phone ?? '').trim()
    && String(profile?.city ?? '').trim(),
  );
  const memberSinceYear = formatMemberSince(String(profile?.created_at ?? user?.created_at ?? ''));
  const heroClass = currentLevel.slug === 'legend-militrin'
    ? 'border-amber-300/30 bg-[linear-gradient(135deg,rgba(251,191,36,0.18),rgba(15,23,42,0.88)_40%,rgba(16,185,129,0.12))]'
    : currentLevel.slug === 'diamante'
      ? 'border-cyan-300/30 bg-[linear-gradient(135deg,rgba(34,211,238,0.16),rgba(15,23,42,0.88)_45%,rgba(16,185,129,0.08))]'
      : 'border-slate-800/80 bg-slate-900/70';
  const badgeClass = currentLevel.slug === 'legend-militrin'
    ? 'border-amber-300/40 bg-[linear-gradient(135deg,#fde68a,#f59e0b,#d97706)] text-slate-950 shadow-[0_0_0_1px_rgba(252,211,77,0.2),0_20px_60px_rgba(245,158,11,0.18)]'
    : currentLevel.slug === 'diamante'
      ? 'border-cyan-300/40 bg-[linear-gradient(135deg,#cffafe,#67e8f9,#06b6d4)] text-slate-950 shadow-[0_0_0_1px_rgba(103,232,249,0.2),0_20px_50px_rgba(6,182,212,0.16)]'
      : 'border-emerald-400/30 bg-[linear-gradient(135deg,#34d399,#10b981,#047857)] text-slate-950 shadow-[0_0_0_1px_rgba(16,185,129,0.18),0_20px_50px_rgba(16,185,129,0.12)]';

  return (
    <section className="space-y-5">
      {!profileComplete ? (
        <div className="rounded-[1.75rem] border border-amber-400/30 bg-amber-400/10 px-5 py-4 text-sm text-amber-100">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p>Complete seus dados para comprar ingressos.</p>
            <Link href="/minha-conta/dados" className="inline-flex h-10 items-center justify-center rounded-2xl border border-amber-300/40 bg-amber-300/10 px-4 font-semibold text-amber-100 transition hover:bg-amber-300/20">
              Completar perfil
            </Link>
          </div>
        </div>
      ) : null}

      <div className={`rounded-[2.25rem] border p-6 shadow-lg shadow-black/10 ${heroClass}`}>
        <div className="flex flex-col gap-5 xl:flex-row">
          <div className="flex-1 rounded-[2rem] border border-white/10 bg-white/5 p-6 backdrop-blur">
            <p className="text-xs uppercase tracking-[0.24em] text-emerald-300">CONTA MILITRIN</p>
            <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-4xl font-semibold text-white">Olá, {greetingName}</h2>
                <p className="mt-2 text-sm text-slate-300">Seu acesso à comunidade Militrin começa aqui.</p>
              </div>
              <div className="flex items-center gap-3">
                <div className="relative h-20 w-20 overflow-hidden rounded-[1.75rem] border border-white/20 bg-slate-900">
                  {profilePhotoUrl ? (
                    <Image
                      src={profilePhotoUrl}
                      alt="Foto do participante"
                      fill
                      unoptimized
                      className="object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-2xl font-semibold text-slate-300">
                      {greetingInitials || 'MP'}
                    </div>
                  )}
                </div>
                <div className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border text-xl font-semibold ${badgeClass}`}>
                  {String(currentLevel.badge).slice(0, 2)}
                </div>
              </div>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Seu nível no Militrin</p>
                <p className="mt-3 text-2xl font-semibold text-white">{String(currentLevel.name)}</p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Badge atual</p>
                <p className="mt-3 text-2xl font-semibold text-white">{String(currentLevel.badge)}</p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Participações confirmadas</p>
                <p className="mt-3 text-2xl font-semibold text-white">{confirmedParticipations}</p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Ingressos ativos</p>
                <p className="mt-3 text-2xl font-semibold text-white">{activeTickets.length}</p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-slate-950/50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Desde</p>
                <p className="mt-3 text-2xl font-semibold text-white">{memberSinceYear}</p>
              </div>
            </div>

            <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Próximo nível</p>
                  <p className="mt-2 text-sm text-slate-200">{formatProgressMessage(progress.remaining, progress.next?.name ?? null, progress.completed)}</p>
                </div>
                <span className="rounded-full border border-emerald-500/40 px-3 py-1 text-xs uppercase tracking-wide text-emerald-200">
                  {progress.completed ? '100%' : `${Math.round(progress.progress)}%`}
                </span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
                <div className="h-full rounded-full bg-emerald-400" style={{ width: `${progress.progress}%` }} />
              </div>
            </div>
          </div>

          <aside className="w-full rounded-[2rem] border border-slate-800 bg-slate-950/70 p-6 xl:max-w-sm">
            <p className="text-xs uppercase tracking-[0.24em] text-emerald-300">Próximo evento</p>
            {nextEvent ? (
              <div className="mt-4 space-y-4">
                <div>
                  <h3 className="text-2xl font-semibold text-white">{String(nextEvent.name)}</h3>
                  <p className="mt-2 text-sm text-slate-300">{nextEvent.starts_at ? formatDateBR(String(nextEvent.starts_at)) : 'Data a confirmar'}</p>
                  <p className="text-sm text-slate-300">{nextEvent.location ?? 'Local a confirmar'}</p>
                </div>
                <Link href="/minha-conta/comprar" className="inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300">
                  Comprar ingresso
                </Link>
              </div>
            ) : (
              <div className="mt-4 space-y-4 text-sm text-slate-300">
                <p>Nenhum evento com inscrições abertas no momento.</p>
                <Link href="/minha-conta/comprar" className="inline-flex h-11 items-center justify-center rounded-2xl border border-slate-700 bg-slate-900/70 px-5 font-semibold text-white transition hover:border-slate-500 hover:bg-slate-900">
                  Ver compras
                </Link>
              </div>
            )}
          </aside>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Link href="/minha-conta/comprar" className="rounded-[1.75rem] border border-emerald-400/20 bg-emerald-400/10 p-5 text-emerald-100 transition hover:border-emerald-300/50 hover:bg-emerald-400/15">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Comprar ingresso</p>
          <h3 className="mt-2 text-xl font-semibold text-white">Garanta sua participação no próximo evento.</h3>
        </Link>

        <Link href="/minha-conta/compras" className="rounded-[1.75rem] border border-slate-800 bg-slate-950/60 p-5 transition hover:border-slate-600 hover:bg-slate-950">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Suas compras</p>
          <h3 className="mt-2 text-xl font-semibold text-white">Acompanhe pagamentos e pedidos.</h3>
        </Link>

        <Link href="/minha-conta/ingressos" className="rounded-[1.75rem] border border-slate-800 bg-slate-950/60 p-5 transition hover:border-slate-600 hover:bg-slate-950">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Meus ingressos</p>
          <h3 className="mt-2 text-xl font-semibold text-white">Acesse seus QR Codes confirmados.</h3>
        </Link>

        <Link href="/minha-conta/nivel" className="rounded-[1.75rem] border border-slate-800 bg-slate-950/60 p-5 transition hover:border-slate-600 hover:bg-slate-950">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Meu nível</p>
          <h3 className="mt-2 text-xl font-semibold text-white">Veja seu progresso na comunidade Militrin.</h3>
        </Link>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <article className="rounded-[1.75rem] border border-slate-800 bg-slate-950/60 p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Compra pendente</p>
          {pendingOrder ? (
            <div className="mt-3 space-y-2 text-sm text-slate-200">
              <p>Pedido: {String(pendingOrder.order_number ?? '-')}</p>
              <p>Valor: {money(Number(pendingOrder.final_amount ?? 0))}</p>
              <p>Status: {String(pendingOrder.status)}</p>
              <Link href={`/minha-conta/compras/${pendingOrder.id}`} className="inline-flex h-10 items-center justify-center rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 text-xs font-semibold text-amber-100 transition hover:bg-amber-400/20">
                Ver compra pendente
              </Link>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-300">Nenhuma compra pendente no momento.</p>
          )}
        </article>

        <article className="rounded-[1.75rem] border border-slate-800 bg-slate-950/60 p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Ingresso confirmado mais recente</p>
          {latestConfirmedOrder ? (
            <div className="mt-3 space-y-2 text-sm text-slate-200">
              <p>Evento: {String((Array.isArray(latestConfirmedOrder.events) ? latestConfirmedOrder.events[0] : latestConfirmedOrder.events)?.name ?? 'Evento')}</p>
              <p>Pedido: {String(latestConfirmedOrder.order_number ?? '-')}</p>
              <Link href={`/minha-conta/compras/${latestConfirmedOrder.id}`} className="inline-flex h-10 items-center justify-center rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-400/20">
                Ver ingresso confirmado
              </Link>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-300">Seu ingresso confirmado mais recente aparecerá aqui.</p>
          )}
        </article>
      </div>

      {!orders.length ? (
        <div className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-6 text-center text-slate-300">
          <p className="text-lg font-semibold text-white">Você ainda não possui ingressos.</p>
          <p className="mt-2 text-sm text-slate-300">Escolha um evento aberto e crie seu primeiro ingresso no portal.</p>
          <Link href="/minha-conta/comprar" className="mt-4 inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300">
            Comprar meu primeiro ingresso
          </Link>
        </div>
      ) : null}
    </section>
  );
}