import Link from 'next/link';
import { CircleUserRound } from 'lucide-react';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';
import { optionalDisplayValue } from '@/lib/optional-display';
import { getAccessibleTicketScope, getAccountOrders, resolveAccountOrderStatus } from '@/lib/account/portal-orders-and-tickets';
import { buildAccountHomeTicketCards } from '@/lib/account/home-ticket-cards';
import { resolveHomeFeaturedEventCta } from '@/lib/account/home-ticket-cta';
import { resolveParticipantFirstName, resolveParticipantFullName } from '@/lib/account/participant-identity';
import { canContinueCommercialPayment } from '@/lib/dashboard/commercial-status';
import { getPrimaryAccountHeaderEvent } from '@/lib/account/header-event';
import { resolveTicketPresentationMode } from '@/lib/checkout/ticket-presentation';
import { BetaFeedbackWidget } from '@/components/feedback/BetaFeedbackWidget';
import { HomeTicketCarousel } from './home-ticket-carousel';
import { HomeFeaturedEvents, type HomeFeaturedEvent } from './home-featured-events';
import { HomeFeaturedHero } from './home-featured-hero';
import { HomeStoreBanner } from './home-store-banner';
import { HomePendingPurchase } from './home-pending-purchase';
import { classifyTicketOperationalSituation } from '@/lib/tickets/ticket-situation';

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

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return (value[0] ?? null) as T | null;
  return (value ?? null) as T | null;
}

export default async function MinhaContaPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [profileResult, ordersResult, eventsResult, featuredEventsResult, headerEvent] = await Promise.all([
    supabase.rpc('get_customer_profile', { p_user_id: user?.id ?? null }),
    getAccountOrders(supabase, user?.id ?? ''),
    supabase
      .from('events')
      .select('id, name, slug, starts_at, ends_at, location, registration_enabled, registration_open_at, registration_close_at')
      .eq('registration_enabled', true)
      .order('starts_at', { ascending: true, nullsFirst: false }),
    supabase.rpc('get_featured_events_for_dashboard'),
    getPrimaryAccountHeaderEvent(supabase),
  ]);

  if (ordersResult.error) {
    console.error('[minha-conta] erro ao carregar pedidos canônicos', ordersResult.error);
    return <section className="rounded-3xl border border-rose-700/40 bg-rose-950/20 p-5 text-sm text-rose-100">Não foi possível carregar o dashboard agora.</section>;
  }

  const orders = (ordersResult.data ?? []) as Array<Record<string, unknown>>;
  const ticketScope = await getAccessibleTicketScope(supabase, user?.id ?? '', orders);
  if (ticketScope.error) {
    console.error('[minha-conta] erro ao carregar ingressos canônicos', { stage: ticketScope.stage, error: ticketScope.error });
    return <section className="rounded-3xl border border-rose-700/40 bg-rose-950/20 p-5 text-sm text-rose-100">Não foi possível carregar o dashboard agora.</section>;
  }

  const profile = (Array.isArray(profileResult.data) ? profileResult.data[0] : profileResult.data) as Record<string, unknown> | null;
  const userMetadata = (user?.user_metadata as Record<string, unknown> | undefined) ?? null;
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
  const allTickets = ticketScope.tickets as Array<{
    id: string;
    status: string | null;
    token: string | null;
    order_id: string | null;
    order_item_id: string | null;
    event_id: string | null;
  }>;
  const homeEventIds = Array.from(new Set(allTickets.map((ticket) => String(ticket.event_id ?? '')).filter(Boolean)));
  const { data: homeEvents } = homeEventIds.length > 0
    ? await supabase.from('events').select('id, starts_at, ends_at, is_active').in('id', homeEventIds)
    : { data: [] as Array<{ id: string; starts_at: string | null; ends_at: string | null; is_active: boolean | null }> };
  const homeEventsById = new Map(((homeEvents ?? []) as Array<{ id: string; starts_at: string | null; ends_at: string | null; is_active: boolean | null }>).map((row) => [String(row.id), row]));
  const activeTickets = allTickets.filter((ticket) => {
    const eventObj = homeEventsById.get(String(ticket.event_id ?? ''));
    return classifyTicketOperationalSituation({
      ticketStatus: ticket.status,
      eventEndsAt: eventObj?.ends_at,
      eventStartsAt: eventObj?.starts_at,
      eventIsActive: eventObj?.is_active,
    }) === 'ativos';
  });
  const archivedTicketCount = allTickets.length - activeTickets.length;

  const displayName = resolveParticipantFullName({ profile, userMetadata, email: user?.email });
  const greetingName = resolveParticipantFirstName(displayName);

  const pendingOrder = orders.find((order) => canContinueCommercialPayment(resolveAccountOrderStatus(order))) ?? null;

  const ticketCards = await buildAccountHomeTicketCards(supabase, activeTickets);
  const featuredHeroCta = headerEvent
    ? resolveHomeFeaturedEventCta({
      showBuyButton: Boolean(headerEvent.showBuyButton),
      buyHref: headerEvent.buyHref ?? '/minha-conta/comprar',
      eventHref: headerEvent.slug ? `/eventos/${headerEvent.slug}` : null,
    })
    : null;

  const listedEvents = dashboardEvents
    .filter((event) => String(event.id) !== String(headerEvent?.id ?? ''))
    .slice(0, 2);
  const categoryResults = await Promise.all(listedEvents.map((event) => (
    event?.id
      ? supabase.rpc('get_event_ticket_categories', { p_event_id: event.id })
      : Promise.resolve({ data: null })
  )));
  const cardEventsRaw = listedEvents.map((event, index) => {
    const categoriesData = (Array.isArray(categoryResults[index]?.data) ? categoryResults[index].data : []) as Array<{ confirmed_count?: number; capacity?: number | null }>;
    const lowestAmount = findInitialPrice(categoriesData as Array<Record<string, unknown>>);
    const totalCapacity = categoriesData.reduce((sum, row) => sum + (Number.isFinite(Number(row.capacity)) ? Number(row.capacity) : 0), 0);
    const totalConfirmed = categoriesData.reduce((sum, row) => sum + Number(row.confirmed_count ?? 0), 0);
    const soldPercent = totalCapacity > 0 ? Math.round((totalConfirmed / totalCapacity) * 100) : null;

    return {
      id: String(event.id),
      name: String(event.name),
      date: event.starts_at ? formatDateBR(String(event.starts_at)) : 'Data a confirmar',
      location: event.location ? String(event.location) : 'Local a confirmar',
      registrationStatus: getRegistrationStatus(event),
      startingPrice: lowestAmount !== null ? money(lowestAmount) : null,
      soldPercent,
      isHot: soldPercent !== null && soldPercent >= 50,
      bannerUrl: null,
      buyHref: event.slug ? `/inscricao/${event.slug}` : '/minha-conta/comprar',
    } satisfies HomeFeaturedEvent;
  });

  const pendingOrderDetail = await (async () => {
    if (!pendingOrder) return null;
    const eventObj = firstRelation(pendingOrder.events as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
    const eventId = String(pendingOrder.event_id ?? '');
    const [itemsResult, categoriesRpc] = await Promise.all([
      supabase.from('order_items').select('ticket_category_id, batch_id, item_kind').eq('order_id', String(pendingOrder.id)),
      eventId ? supabase.rpc('get_event_ticket_categories', { p_event_id: eventId }) : Promise.resolve({ data: null }),
    ]);
    const items = ((itemsResult.data ?? []) as Array<{ ticket_category_id: string | null; batch_id: string | null; item_kind: string | null }>)
      .filter((item) => (item.item_kind ?? 'ticket') === 'ticket');
    const firstItem = items[0] ?? null;
    const categoryRows = (Array.isArray(categoriesRpc.data) ? categoriesRpc.data : []) as Array<{ is_active: boolean; available_slots: number | null; current_batch_name: string | null }>;
    const activeCategoryCount = categoryRows.filter((row) => row.is_active && (row.available_slots === null || row.available_slots > 0) && row.current_batch_name !== null).length;
    const presentationMode = resolveTicketPresentationMode(activeCategoryCount);

    const [categoryNameResult, batchNameResult] = await Promise.all([
      firstItem?.ticket_category_id ? supabase.from('ticket_categories').select('name').eq('id', firstItem.ticket_category_id).maybeSingle() : Promise.resolve({ data: null }),
      firstItem?.batch_id ? supabase.from('registration_batches').select('name').eq('id', firstItem.batch_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);

    return {
      eventName: eventObj?.name ? String(eventObj.name) : 'Evento',
      quantity: items.length,
      categoryLabel: presentationMode === 'category_visible' ? optionalDisplayValue((categoryNameResult.data as { name: string | null } | null)?.name) : null,
      batchLabel: presentationMode === 'single' ? null : optionalDisplayValue((batchNameResult.data as { name: string | null } | null)?.name),
    };
  })();

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight text-white">Olá, {greetingName}!</h1>
          <p className="mt-0.5 text-xs text-slate-400">Bem-vindo à sua conta Militrin.</p>
        </div>
        <Link
          href="/minha-conta/dados"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-slate-700 bg-slate-950/70 text-slate-100 hover:border-slate-500 sm:w-auto sm:gap-2 sm:px-3"
          aria-label="Ver meu perfil"
        >
          <CircleUserRound size={16} />
          <span className="hidden sm:inline text-sm font-semibold">Perfil</span>
        </Link>
      </header>

      {headerEvent ? <HomeFeaturedHero event={headerEvent} cta={featuredHeroCta} /> : null}

      <div className={pendingOrder && pendingOrderDetail ? 'grid gap-3 lg:grid-cols-2' : undefined}>
        <HomeTicketCarousel
          tickets={ticketCards}
          emptyTitle={archivedTicketCount > 0 ? 'Você não possui ingressos ativos.' : undefined}
          emptyDescription={archivedTicketCount > 0 ? 'Ingressos de eventos encerrados ou cancelados ficam em anteriores e inativos.' : undefined}
          emptyHref={archivedTicketCount > 0 ? '/minha-conta/ingressos?ver=anteriores' : undefined}
          emptyLabel={archivedTicketCount > 0 ? `Anteriores e inativos (${archivedTicketCount})` : undefined}
        />

        {pendingOrder && pendingOrderDetail ? (
          <HomePendingPurchase
            orderId={String(pendingOrder.id)}
            eventName={pendingOrderDetail.eventName}
            quantity={pendingOrderDetail.quantity}
            categoryLabel={pendingOrderDetail.categoryLabel}
            batchLabel={pendingOrderDetail.batchLabel}
            amount={Number(pendingOrder.final_amount ?? 0)}
          />
        ) : null}
      </div>

      <HomeStoreBanner />

      {cardEventsRaw.length > 0 ? (
        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-white">Eventos em destaque</h2>
            <Link href="/eventos" className="text-xs font-semibold text-slate-400 hover:text-slate-200">
              Ver todos
            </Link>
          </div>
          <HomeFeaturedEvents events={cardEventsRaw} />
        </section>
      ) : null}

      <BetaFeedbackWidget />
    </section>
  );
}
