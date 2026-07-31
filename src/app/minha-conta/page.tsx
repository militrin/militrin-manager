import Link from 'next/link';
import { CalendarDays, Medal, QrCode, ShoppingBag, Ticket, UserRound } from 'lucide-react';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR, formatDateTimeBR } from '@/lib/utils/date';
import { getLoyaltyLevel, getLoyaltyProgress, normalizeLoyaltyLevel, sortLoyaltyLevels } from '@/lib/account/levels';
import {
  resolveParticipantAvatarUrl,
  resolveParticipantFirstName,
  resolveParticipantFullName,
  resolveParticipantInitials,
} from '@/lib/account/participant-identity';
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

function earliestDate(values: Array<string | null | undefined>) {
  const timestamps = values
    .map((value) => (value ? new Date(value).getTime() : NaN))
    .filter((value) => Number.isFinite(value));

  if (!timestamps.length) return null;
  return new Date(Math.min(...timestamps)).toISOString();
}

function getRegistrationStatus(event: { registration_open_at: string | null; registration_close_at: string | null }) {
  const now = Date.now();
  const openAt = event.registration_open_at ? new Date(event.registration_open_at).getTime() : null;
  const closeAt = event.registration_close_at ? new Date(event.registration_close_at).getTime() : null;

  if (openAt && openAt > now) return 'abre em breve';
  if (closeAt && closeAt < now) return 'encerradas';
  return 'abertas';
}

function findInitialPrice(rows: Array<Record<string, unknown>>) {
  const candidates = rows
    .map((row) => {
      const possible = [row.initial_price, row.starting_price, row.final_amount, row.base_amount, row.price];
      for (const value of possible) {
        const amount = Number(value ?? NaN);
        if (Number.isFinite(amount) && amount > 0) return amount;
      }
      return NaN;
    })
    .filter((value) => Number.isFinite(value));

  if (!candidates.length) return null;
  return Math.min(...candidates);
}

function formatProgressMessage(params: {
  remaining: number;
  nextLevelName: string | null;
  completed: boolean;
  confirmedParticipations: number;
  currentLevelSlug: string;
}) {
  const { remaining, nextLevelName, completed, confirmedParticipations, currentLevelSlug } = params;

  if (currentLevelSlug.toLowerCase() === 'novato' && confirmedParticipations === 0) {
    return 'Registre sua primeira participação para começar sua evolução.';
  }

  if (completed) {
    return 'Você alcançou o nível máximo do Militrin.';
  }

  if (!nextLevelName) {
    return 'Seu próximo nível será exibido assim que houver uma nova faixa configurada.';
  }

  return remaining === 1
    ? `Falta 1 participação oficial para chegar ao ${nextLevelName}.`
    : `Faltam ${remaining} participações oficiais para chegar ao ${nextLevelName}.`;
}

export default async function MinhaContaPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [profileResult, ordersResult, ticketsResult, eventsResult, tiersResult, featuredEventsResult, kitDeliveriesResult] = await Promise.all([
    supabase.rpc('get_customer_profile', { p_user_id: user?.id ?? null }),
    supabase
      .from('orders')
      .select('id, order_number, status, final_amount, created_at, confirmed_at, participant_id, participants(full_name), events(id, name, starts_at, location, registration_enabled, registration_open_at, registration_close_at), tickets(id, status, token), payments(payment_method, payment_status)')
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
    supabase.rpc('get_featured_events_for_dashboard'),
    supabase.rpc('get_upcoming_kit_deliveries', { p_limit: 4 }),
  ]);

  const profile = (Array.isArray(profileResult.data) ? profileResult.data[0] : profileResult.data) as Record<string, unknown> | null;
  const userMetadata = (user?.user_metadata as Record<string, unknown> | undefined) ?? null;
  const loyaltyLevels = sortLoyaltyLevels((tiersResult.data ?? []).map((level) => normalizeLoyaltyLevel(level as Record<string, unknown>)));
  const orders = ordersResult.data ?? [];
  const openEvents = (eventsResult.data ?? []).filter((event) => isEventOpen(event));
  const featuredEvents = ((featuredEventsResult.data ?? []) as Array<{
    event_id: string;
    sort_order: number;
    name: string;
    slug: string;
    starts_at: string | null;
    ends_at: string | null;
    location: string | null;
    registration_enabled: boolean;
    registration_open_at: string | null;
    registration_close_at: string | null;
  }>).map((event) => ({
    id: String(event.event_id),
    name: String(event.name ?? 'Evento'),
    slug: String(event.slug ?? ''),
    starts_at: event.starts_at ? String(event.starts_at) : null,
    ends_at: event.ends_at ? String(event.ends_at) : null,
    location: event.location ? String(event.location) : null,
    registration_enabled: Boolean(event.registration_enabled),
    registration_open_at: event.registration_open_at ? String(event.registration_open_at) : null,
    registration_close_at: event.registration_close_at ? String(event.registration_close_at) : null,
    sort_order: Number(event.sort_order ?? 0),
  }));
  const dashboardEvents = featuredEvents.length > 0 ? featuredEvents : openEvents;
  const kitDeliveries = ((kitDeliveriesResult.data ?? []) as Array<{
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
  const allTickets = ticketsResult.data ?? [];
  const activeTickets = allTickets.filter((ticket) => String(ticket.status ?? '') === 'active');
  const highlightedTicket = allTickets.find((ticket) => {
    const status = String(ticket.status ?? '').toLowerCase();
    return status === 'active' || status === 'used';
  }) ?? null;
  const confirmedParticipations = orders.filter((order) => order.status === 'confirmed').length;
  const currentLevel = getLoyaltyLevel(confirmedParticipations, loyaltyLevels);
  const progress = getLoyaltyProgress(confirmedParticipations, loyaltyLevels);

  const displayName = resolveParticipantFullName({
    profile,
    userMetadata,
    email: user?.email,
  });
  const greetingName = resolveParticipantFirstName(displayName);
  const greetingInitials = resolveParticipantInitials(displayName);
  const profilePhotoUrl = resolveParticipantAvatarUrl({
    profile,
    userMetadata,
  });

  const confirmedOrders = orders.filter((order) => String(order.status ?? '') === 'confirmed');
  const firstConfirmedParticipationDate = earliestDate(
    confirmedOrders.map((order) => String(order.confirmed_at ?? order.created_at ?? '')),
  );
  const memberSinceYear = formatMemberSince(
    earliestDate([firstConfirmedParticipationDate, String(profile?.created_at ?? ''), String(user?.created_at ?? '')]),
  );
  const pendingOrder = orders.find((order) => order.status === 'pending') ?? null;
  const latestOrder = orders[0] ?? null;
  const highlightedTicketOrder = highlightedTicket
    ? orders.find((order) => String(order.id ?? '') === String(highlightedTicket.order_id ?? '')) ?? null
    : null;

  const highlightedTicketEventName = (() => {
    const eventObj = Array.isArray(highlightedTicketOrder?.events) ? highlightedTicketOrder?.events[0] : highlightedTicketOrder?.events;
    return eventObj?.name ? String(eventObj.name) : 'Evento Militrin';
  })();

  const cardEvents = await Promise.all(dashboardEvents.slice(0, 2).map(async (event) => {
    let startingPrice: string | null = null;
    if (event?.id) {
      const { data: categoriesData } = await supabase.rpc('get_event_ticket_categories', { p_event_id: event.id });
      if (Array.isArray(categoriesData)) {
        const lowestAmount = findInitialPrice(categoriesData as Array<Record<string, unknown>>);
        if (lowestAmount !== null) startingPrice = money(lowestAmount);
      }
    }

    return {
      id: String(event.id),
      name: String(event.name),
      date: event.starts_at ? formatDateBR(String(event.starts_at)) : 'Data a confirmar',
      location: event.location ? String(event.location) : 'Local a confirmar',
      registrationStatus: getRegistrationStatus(event),
      startingPrice,
    };
  }));
  return (
    <section className="space-y-5">
      <MilitrinSection
        eyebrow="Dashboard"
        title={`Olá, ${greetingName}!`}
        description="Bem-vindo ao Portal do Participante Militrin."
        action={
          highlightedTicket ? (
            <Link href={`/minha-conta/ingressos/${highlightedTicket.id}`}>
              <MilitrinButton iconLeft={<QrCode size={15} />}>Ver QR Code</MilitrinButton>
            </Link>
          ) : null
        }
      >
        <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
          <article className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Cartão do participante</p>
            <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <MilitrinAvatar src={profilePhotoUrl} alt={`Foto do participante ${displayName}`} initials={greetingInitials} size="lg" />
                <div className="min-w-0">
                  <p className="truncate text-xl font-semibold text-white" title={displayName} aria-label={displayName}>{displayName}</p>
                  <p className="text-sm text-slate-300">Participante desde {memberSinceYear}</p>
                </div>
              </div>
              <MilitrinBadge tone="success">{String(currentLevel.badge)}</MilitrinBadge>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <MilitrinStat label="Categoria atual" value={String(currentLevel.name)} icon={<Medal size={14} />} />
              <MilitrinStat label="Participações oficiais" value={confirmedParticipations} icon={<CalendarDays size={14} />} />
              <MilitrinStat label="Nível atual" value={String(currentLevel.badge)} icon={<Ticket size={14} />} />
            </div>

            <div className="mt-4">
              <MilitrinProgress
                label="Progresso para próxima categoria"
                value={progress.progress}
                helper={formatProgressMessage({
                  remaining: progress.remaining,
                  nextLevelName: progress.next?.name ?? null,
                  completed: progress.completed,
                  confirmedParticipations,
                  currentLevelSlug: currentLevel.slug,
                })}
              />
            </div>
          </article>

          <MilitrinEventCard
            events={cardEvents.map((event, index) => ({
              ...event,
              buyHref: dashboardEvents[index]?.slug ? `/inscricao/${dashboardEvents[index].slug}` : '/minha-conta/comprar',
            }))}
          />
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <article className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Seu ingresso</p>
            {highlightedTicket ? (
              <div className="mt-3 space-y-3 text-sm text-slate-200">
                <p className="truncate font-semibold text-white" title={highlightedTicketEventName}>{highlightedTicketEventName}</p>
                <Link href={`/minha-conta/ingressos/${highlightedTicket.id}`}>
                  <MilitrinButton variant="success" iconLeft={<QrCode size={15} />}>Abrir QR Code</MilitrinButton>
                </Link>
              </div>
            ) : confirmedOrders.length > 0 ? (
              <div className="mt-3 space-y-3 text-sm text-slate-200">
                <p className="text-slate-300">Compra confirmada encontrada. O ingresso pode estar em processamento de emissão.</p>
                <Link href={`/minha-conta/compras/${confirmedOrders[0].id}`}>
                  <MilitrinButton variant="secondary" iconLeft={<Ticket size={15} />}>Acompanhar confirmação</MilitrinButton>
                </Link>
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-300">Nenhum ingresso ativo no momento.</p>
            )}
          </article>

          <article className="rounded-3xl border border-slate-800 bg-slate-950/60 p-5">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Cronograma de entrega de kits</p>
            {kitDeliveries.length > 0 ? (
              <div className="mt-3 space-y-3 text-sm text-slate-200">
                {kitDeliveries.map((item) => (
                  <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2">
                    <p className="font-semibold text-white">{formatDateTimeBR(item.delivery_at, ' às ')}</p>
                    <p>{item.city}</p>
                    <p className="truncate" title={item.location}>{item.location}</p>
                  </div>
                ))}
                <Link href="/minha-conta/entregas" className="inline-flex h-10 items-center justify-center rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-400/20">
                  Ver todas as entregas registradas!
                </Link>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <p className="text-sm text-slate-300">Nenhuma entrega de kits programada no momento.</p>
                <Link href="/minha-conta/entregas" className="inline-flex h-10 items-center justify-center rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-400/20">
                  Ver todas as entregas registradas!
                </Link>
              </div>
            )}
          </article>
        </div>
      </MilitrinSection>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MilitrinStat label="Compras" value={orders.length} icon={<ShoppingBag size={14} />} className="border-slate-800 bg-slate-950/60" />
        <MilitrinStat label="Ingressos ativos" value={activeTickets.length} icon={<Ticket size={14} />} className="border-slate-800 bg-slate-950/60" />
        <MilitrinStat label="Participações oficiais" value={confirmedParticipations} icon={<CalendarDays size={14} />} className="border-slate-800 bg-slate-950/60" />
        <MilitrinStat label="Nível atual" value={String(currentLevel.name)} icon={<Medal size={14} />} className="border-slate-800 bg-slate-950/60" />
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
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Resumo rápido</p>
          {latestOrder ? (
            <div className="mt-3 space-y-2 text-sm text-slate-200">
              <p>Último pedido: {String(latestOrder.order_number ?? '-')}</p>
              <p>Status: {String(latestOrder.status ?? '-')}</p>
              <Link href={`/minha-conta/compras/${latestOrder.id}`} className="inline-flex h-10 items-center justify-center rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-400/20">
                Ver detalhes
              </Link>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-300">Seu primeiro pedido aparecerá aqui.</p>
          )}
        </article>
      </section>

      {!orders.length ? (
        <MilitrinEmptyState
          title="Você ainda não possui ingressos."
          description="Escolha um evento aberto e crie seu primeiro ingresso no portal."
          actionHref="/minha-conta/comprar"
          actionLabel="Comprar meu primeiro ingresso"
        />
      ) : null}
    </section>
  );
}
