import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { EVENT_TIMEZONE, formatCompactEventWhen, formatDateBR } from '@/lib/utils/date';
import { optionalDisplayValue } from '@/lib/optional-display';
import { accountTicketItemCount, getAccessibleTicketScope, getAccountOrders, resolveAccountOrderStatus } from '@/lib/account/portal-orders-and-tickets';
import { buildAccountHomeTicketCards } from '@/lib/account/home-ticket-cards';
import { resolveHomeFeaturedEventCta } from '@/lib/account/home-ticket-cta';
import { resolveParticipantFirstName, resolveParticipantFullName, resolveParticipantInitials } from '@/lib/account/participant-identity';
import { canContinueCommercialPayment } from '@/lib/dashboard/commercial-status';
import { getPrimaryAccountHeaderEvent } from '@/lib/account/header-event';
import { getMyPublicPin } from '@/lib/account/public-pin';
import { resolveTicketPresentationMode } from '@/lib/checkout/ticket-presentation';
import { getStoreItemsForEvents } from '@/lib/store/get-store-items';
import { BetaFeedbackWidget } from '@/components/feedback/BetaFeedbackWidget';
import { HomeTicketCarousel } from './home-ticket-carousel';
import { HomeFeaturedEvents, type HomeFeaturedEvent } from './home-featured-events';
import { HomeFeaturedHero } from './home-featured-hero';
import { HomeStoreBanner } from './home-store-banner';
import { HomePendingPurchase } from './home-pending-purchase';
import { HomeSponsorsCarousel, type HomeSponsor } from './home-sponsors-carousel';
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

function compactDayMonth(startsAt: string | null) {
  if (!startsAt) return 'Data a confirmar';
  const line = formatCompactEventWhen(startsAt, null);
  return line ? line.split(' · ')[0] : formatDateBR(startsAt);
}

function eventWeekday(startsAt: string | null) {
  if (!startsAt) return null;
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return null;
  const weekday = new Intl.DateTimeFormat('pt-BR', { timeZone: EVENT_TIMEZONE, weekday: 'long' }).format(start);
  return weekday.charAt(0).toUpperCase() + weekday.slice(1);
}

export default async function MinhaContaPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [profileResult, ordersResult, eventsResult, featuredEventsResult, sponsorsResult, headerEvent, publicPin] = await Promise.all([
    supabase.rpc('get_customer_profile', { p_user_id: user?.id ?? null }),
    getAccountOrders(supabase, user?.id ?? ''),
    supabase
      .from('events')
      .select('id, name, slug, year, starts_at, ends_at, location, registration_enabled, registration_open_at, registration_close_at')
      .eq('registration_enabled', true)
      .order('starts_at', { ascending: true, nullsFirst: false }),
    supabase.rpc('get_featured_events_for_dashboard'),
    supabase.rpc('get_active_sponsors_for_home'),
    getPrimaryAccountHeaderEvent(supabase),
    getMyPublicPin(user?.id),
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
    year?: number | null;
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
    year: event.year == null ? null : Number(event.year),
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
  const greetingInitials = resolveParticipantInitials(displayName);

  const pendingOrder = orders.find((order) => canContinueCommercialPayment(resolveAccountOrderStatus(order))) ?? null;

  const ticketCards = await buildAccountHomeTicketCards(supabase, activeTickets);
  const featuredHeroCta = headerEvent
    ? resolveHomeFeaturedEventCta({
      showBuyButton: Boolean(headerEvent.showBuyButton),
      buyHref: headerEvent.buyHref ?? '/minha-conta/comprar',
      eventHref: headerEvent.slug ? `/eventos/${headerEvent.slug}` : null,
    })
    : null;

  const listedEvents = dashboardEvents.slice(0, 3);
  const listedEventIds = listedEvents.map((event) => String(event.id)).filter(Boolean);
  const storeEventIds = Array.from(new Set([
    ...ticketScope.ownedEventIds,
    ...listedEventIds,
    headerEvent?.id ? String(headerEvent.id) : '',
  ].filter(Boolean)));

  const [bannerRowsResult, storeItems, ...categoryResults] = await Promise.all([
    listedEventIds.length > 0
      ? supabase.from('events').select('id, year, banner_card_url, banner_hero_url').in('id', listedEventIds)
      : Promise.resolve({ data: [] as Array<{ id: string; year: number | null; banner_card_url: string | null; banner_hero_url: string | null }> }),
    storeEventIds.length > 0 ? getStoreItemsForEvents(supabase, storeEventIds) : Promise.resolve([]),
    ...listedEvents.map((event) => (
      event?.id
        ? supabase.rpc('get_event_ticket_categories', { p_event_id: event.id })
        : Promise.resolve({ data: null })
    )),
  ]);
  const bannersById = new Map(
    ((bannerRowsResult.data ?? []) as Array<{ id: string; year: number | null; banner_card_url: string | null; banner_hero_url: string | null }>).map((row) => [String(row.id), row]),
  );
  const storeImageUrls = storeItems.map((item) => item.imageUrl).filter((url): url is string => Boolean(url)).slice(0, 3);
  const storeProducts = storeItems
    .filter((item) => Boolean(item.imageUrl))
    .slice(0, 3)
    .map((item) => ({ id: String(item.id), name: String(item.name), imageUrl: String(item.imageUrl) }));

  const sponsorRows = (sponsorsResult.data ?? []) as Array<{
    sponsor_id: string;
    name: string;
    banner_url: string | null;
    link_url: string | null;
    carousel_interval_seconds?: number | null;
  }>;
  const sponsors: HomeSponsor[] = sponsorRows
    .filter((row) => Boolean(row.banner_url))
    .map((row) => ({
      id: String(row.sponsor_id),
      name: String(row.name),
      bannerUrl: String(row.banner_url),
      linkUrl: row.link_url ? String(row.link_url) : null,
    }));
  const sponsorIntervalSeconds = Number(sponsorRows[0]?.carousel_interval_seconds ?? 4);

  const cardEventsRaw = listedEvents.map((event, index) => {
    const categoriesData = (Array.isArray(categoryResults[index]?.data) ? categoryResults[index].data : []) as Array<{ confirmed_count?: number; capacity?: number | null }>;
    const lowestAmount = findInitialPrice(categoriesData as Array<Record<string, unknown>>);
    const totalCapacity = categoriesData.reduce((sum, row) => sum + (Number.isFinite(Number(row.capacity)) ? Number(row.capacity) : 0), 0);
    const totalConfirmed = categoriesData.reduce((sum, row) => sum + Number(row.confirmed_count ?? 0), 0);
    const soldPercent = totalCapacity > 0 ? Math.round((totalConfirmed / totalCapacity) * 100) : null;
    const banner = bannersById.get(String(event.id));
    const year = banner?.year ?? ('year' in event ? Number(event.year) || null : null);

    return {
      id: String(event.id),
      name: String(event.name),
      year,
      date: event.starts_at ? formatDateBR(String(event.starts_at)) : 'Data a confirmar',
      compactDate: compactDayMonth(event.starts_at ? String(event.starts_at) : null),
      weekday: eventWeekday(event.starts_at ? String(event.starts_at) : null),
      location: event.location ? String(event.location) : 'Local a confirmar',
      registrationStatus: getRegistrationStatus(event),
      startingPrice: lowestAmount !== null ? money(lowestAmount) : null,
      soldPercent,
      isHot: soldPercent !== null && soldPercent >= 50,
      isFeatured: Boolean(headerEvent?.id) && String(event.id) === String(headerEvent?.id),
      bannerUrl: banner?.banner_card_url || banner?.banner_hero_url || null,
      eventHref: event.slug ? `/eventos/${event.slug}` : '/eventos',
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
      quantity: accountTicketItemCount(pendingOrder),
      categoryLabel: presentationMode === 'category_visible' ? optionalDisplayValue((categoryNameResult.data as { name: string | null } | null)?.name) : null,
      batchLabel: presentationMode === 'single' ? null : optionalDisplayValue((batchNameResult.data as { name: string | null } | null)?.name),
    };
  })();

  const hasPendingPurchase = Boolean(pendingOrder && pendingOrderDetail);

  return (
    <section className="space-y-3 sm:space-y-4 lg:space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight text-white sm:text-2xl">Olá, {greetingName}!</h1>
          <p className="mt-0.5 truncate text-xs text-slate-400 sm:text-sm">
            Bem-vindo à sua conta Militrin.
            <span className="hidden sm:inline"> Aqui é onde a experiência começa.</span>
          </p>
        </div>
        <Link
          href="/minha-conta/dados"
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-slate-700 bg-slate-950/70 pl-1 pr-2 text-slate-100 transition hover:border-emerald-500/40 sm:h-10 sm:pr-3"
          aria-label="Ver meu perfil"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/15 text-[11px] font-semibold text-emerald-200 sm:h-8 sm:w-8">
            {greetingInitials}
          </span>
          <span className="hidden max-w-[10rem] truncate text-sm font-semibold lg:inline">{displayName}</span>
        </Link>
      </header>

      {headerEvent ? <HomeFeaturedHero event={headerEvent} cta={featuredHeroCta} /> : null}

      <div className={sponsors.length > 0 ? 'flex flex-col gap-3 lg:grid lg:grid-cols-2 lg:items-stretch lg:gap-4' : undefined}>
        <HomeTicketCarousel
          tickets={ticketCards}
          publicPin={publicPin}
          emptyTitle={archivedTicketCount > 0 ? 'Você não possui ingressos ativos.' : undefined}
          emptyDescription={archivedTicketCount > 0 ? 'Ingressos de eventos encerrados ou cancelados ficam em anteriores e inativos.' : undefined}
          emptyHref={archivedTicketCount > 0 ? '/minha-conta/ingressos?ver=anteriores' : undefined}
          emptyLabel={archivedTicketCount > 0 ? `Anteriores e inativos (${archivedTicketCount})` : undefined}
        />

        {sponsors.length > 0 ? (
          <HomeSponsorsCarousel sponsors={sponsors} intervalSeconds={sponsorIntervalSeconds} />
        ) : null}
      </div>

      {cardEventsRaw.length > 0 ? (
        <section>
          <div className="mb-2 flex items-center justify-between gap-3 sm:mb-3">
            <h2 className="text-sm font-semibold text-white sm:text-base">Eventos</h2>
            <Link href="/eventos" className="text-xs font-semibold text-emerald-200 transition hover:text-emerald-100 sm:text-sm">
              Ver todos →
            </Link>
          </div>
          <HomeFeaturedEvents events={cardEventsRaw} />
        </section>
      ) : null}

      <div className={hasPendingPurchase ? 'flex flex-col gap-3 lg:grid lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:items-stretch lg:gap-4' : undefined}>
        {hasPendingPurchase && pendingOrder && pendingOrderDetail ? (
          <div className="order-1 lg:order-2">
            <HomePendingPurchase
              orderId={String(pendingOrder.id)}
              eventName={pendingOrderDetail.eventName}
              quantity={pendingOrderDetail.quantity}
              categoryLabel={pendingOrderDetail.categoryLabel}
              batchLabel={pendingOrderDetail.batchLabel}
              amount={Number(pendingOrder.final_amount ?? 0)}
            />
          </div>
        ) : null}
        <div className={hasPendingPurchase ? 'order-2 lg:order-1' : undefined}>
          <HomeStoreBanner imageUrls={storeImageUrls} products={storeProducts} />
        </div>
      </div>

      <BetaFeedbackWidget />
    </section>
  );
}
