import Link from 'next/link';
import { CalendarDays, Medal, QrCode, ShoppingBag, Ticket, UserRound } from 'lucide-react';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';
import { getLoyaltyLevel, getLoyaltyProgress, normalizeLoyaltyLevel, sortLoyaltyLevels } from '@/lib/account/levels';
import {
  MilitrinAvatar,
  MilitrinBadge,
  MilitrinButton,
  MilitrinEmptyState,
  MilitrinEventCard,
  MilitrinProgress,
  MilitrinSection,
  MilitrinStat,
} from '@/components/militrin';

function isEventOpen(event: { registration_enabled: boolean; registration_open_at: string | null; registration_close_at: string | null }) {
  if (!event.registration_enabled) return false;

  const now = Date.now();
  const openOk = !event.registration_open_at || new Date(event.registration_open_at).getTime() <= now;
  const closeOk = !event.registration_close_at || new Date(event.registration_close_at).getTime() >= now;
  return openOk && closeOk;
}

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function formatMemberSince(value: string | null | undefined) {
  if (!value) return new Date().getFullYear();
  const year = new Date(value).getFullYear();
  return Number.isNaN(year) ? new Date().getFullYear() : year;
}

function formatProgressMessage(remaining: number, nextLevelName: string | null, completed: boolean) {
  if (completed) {
    return 'Voce alcancou o nivel maximo do Militrin.';
  }

  if (!nextLevelName) {
    return 'Seu proximo nivel sera exibido assim que houver uma nova faixa configurada.';
  }

  return remaining === 1
    ? `Falta 1 participacao confirmada para chegar ao ${nextLevelName}.`
    : `Faltam ${remaining} participacoes confirmadas para chegar ao ${nextLevelName}.`;
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
      .select('id, order_number, status, final_amount, created_at, participant_id, participants(full_name), events(name), tickets(id, status, token), payments(payment_method, payment_status)')
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
  const currentLevel = getLoyaltyLevel(confirmedParticipations, loyaltyLevels);
  const progress = getLoyaltyProgress(confirmedParticipations, loyaltyLevels);

  const greetingName = String(profile?.full_name ?? user?.email ?? 'Participante').split(' ')[0];
  const displayName = String(profile?.full_name ?? user?.email ?? 'Participante');
  const profilePhotoUrl = String((user?.user_metadata as Record<string, unknown> | undefined)?.avatar_url ?? '').trim();
  const greetingInitials = displayName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((chunk) => chunk[0]?.toUpperCase() ?? '')
    .join('');

  const nextEvent = openEvents[0] ?? null;
  const latestActiveTicket = activeTickets[0] ?? null;
  const memberSinceYear = formatMemberSince(String(profile?.created_at ?? user?.created_at ?? ''));
  const pendingOrder = orders.find((order) => order.status === 'pending') ?? null;
  const latestOrder = orders[0] ?? null;

  return (
    <section className="space-y-5">
      <MilitrinSection
        eyebrow="Dashboard"
        title={`Ola, ${greetingName}`}
        description="Seu portal premium do participante Militrin."
        action={
          latestActiveTicket ? (
            <Link href={`/minha-conta/ingressos/${latestActiveTicket.id}`}>
              <MilitrinButton iconLeft={<QrCode size={15} />}>Ver QR Code</MilitrinButton>
            </Link>
          ) : null
        }
      >
        <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
          <article className="rounded-[1.5rem] border border-white/10 bg-white/5 p-5 backdrop-blur">
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Cartao de associado</p>
            <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <MilitrinAvatar src={profilePhotoUrl || null} alt="Foto do participante" initials={greetingInitials} size="lg" />
                <div>
                  <p className="text-xl font-semibold text-white">{displayName}</p>
                  <p className="text-sm text-slate-300">Membro desde {memberSinceYear}</p>
                </div>
              </div>
              <MilitrinBadge tone="success">{String(currentLevel.badge)}</MilitrinBadge>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <MilitrinStat label="Categoria" value={String(currentLevel.name)} icon={<Medal size={14} />} />
              <MilitrinStat label="Participacoes" value={confirmedParticipations} icon={<CalendarDays size={14} />} />
              <MilitrinStat label="Nivel" value={String(currentLevel.badge)} icon={<Ticket size={14} />} />
            </div>

            <div className="mt-4">
              <MilitrinProgress
                label="Progresso para proxima categoria"
                value={progress.progress}
                helper={formatProgressMessage(progress.remaining, progress.next?.name ?? null, progress.completed)}
              />
            </div>
          </article>

          <MilitrinEventCard
            name={nextEvent ? String(nextEvent.name) : 'Aguardando novo evento'}
            date={nextEvent?.starts_at ? formatDateBR(String(nextEvent.starts_at)) : 'Data a confirmar'}
            location={nextEvent?.location ? String(nextEvent.location) : 'Local a confirmar'}
            registrationStatus={nextEvent ? 'inscricoes abertas' : 'em breve'}
            action={
              latestActiveTicket ? (
                <Link href={`/minha-conta/ingressos/${latestActiveTicket.id}`}>
                  <MilitrinButton variant="success" iconLeft={<QrCode size={15} />}>Ver QR Code</MilitrinButton>
                </Link>
              ) : (
                <Link href="/minha-conta/comprar">
                  <MilitrinButton iconLeft={<ShoppingBag size={15} />}>Comprar ingresso</MilitrinButton>
                </Link>
              )
            }
          />
        </div>
      </MilitrinSection>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MilitrinStat label="Compras" value={orders.length} icon={<ShoppingBag size={14} />} className="border-slate-800 bg-slate-950/60" />
        <MilitrinStat label="Ingressos ativos" value={activeTickets.length} icon={<Ticket size={14} />} className="border-slate-800 bg-slate-950/60" />
        <MilitrinStat label="Participacoes" value={confirmedParticipations} icon={<CalendarDays size={14} />} className="border-slate-800 bg-slate-950/60" />
        <MilitrinStat label="Nivel atual" value={String(currentLevel.name)} icon={<Medal size={14} />} className="border-slate-800 bg-slate-950/60" />
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Link href="/minha-conta/comprar"><MilitrinButton className="w-full" iconLeft={<ShoppingBag size={15} />}>Comprar ingresso</MilitrinButton></Link>
        <Link href="/minha-conta/ingressos"><MilitrinButton className="w-full" variant="secondary" iconLeft={<Ticket size={15} />}>Ver meus ingressos</MilitrinButton></Link>
        <Link href="/minha-conta/compras"><MilitrinButton className="w-full" variant="secondary" iconLeft={<CalendarDays size={15} />}>Ver compras</MilitrinButton></Link>
        <Link href="/minha-conta/dados"><MilitrinButton className="w-full" variant="secondary" iconLeft={<UserRound size={15} />}>Atualizar perfil</MilitrinButton></Link>
      </section>

      <section className="grid gap-3 xl:grid-cols-2">
        <article className="rounded-[1.75rem] border border-slate-800 bg-slate-950/60 p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Compra pendente</p>
          {pendingOrder ? (
            <div className="mt-3 space-y-2 text-sm text-slate-200">
              <p>Pedido: {String(pendingOrder.order_number ?? '-')}</p>
              <p>Valor: {money(Number(pendingOrder.final_amount ?? 0))}</p>
              <p>Status: {String(pendingOrder.status)}</p>
              <Link href={`/minha-conta/compras/${pendingOrder.id}`} className="inline-flex h-10 items-center justify-center rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 text-xs font-semibold text-amber-100 transition hover:bg-amber-400/20">
                Continuar pagamento
              </Link>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-300">Nenhuma compra pendente no momento.</p>
          )}
        </article>

        <article className="rounded-[1.75rem] border border-slate-800 bg-slate-950/60 p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Resumo rapido</p>
          {latestOrder ? (
            <div className="mt-3 space-y-2 text-sm text-slate-200">
              <p>Ultimo pedido: {String(latestOrder.order_number ?? '-')}</p>
              <p>Status: {String(latestOrder.status ?? '-')}</p>
              <Link href={`/minha-conta/compras/${latestOrder.id}`} className="inline-flex h-10 items-center justify-center rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-400/20">
                Ver detalhes
              </Link>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-300">Seu primeiro pedido aparecera aqui.</p>
          )}
        </article>
      </section>

      {!orders.length ? (
        <MilitrinEmptyState
          title="Voce ainda nao possui ingressos."
          description="Escolha um evento aberto e crie seu primeiro ingresso no portal."
          actionHref="/minha-conta/comprar"
          actionLabel="Comprar meu primeiro ingresso"
        />
      ) : null}
    </section>
  );
}
