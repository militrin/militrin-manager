import Link from 'next/link';
import { ChevronRight, CircleUserRound, Clock, ShieldCheck, Ticket as TicketIcon } from 'lucide-react';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR, formatDateTimeBR } from '@/lib/utils/date';
import { optionalDisplayValue } from '@/lib/optional-display';
import { getAccessibleTicketScope, getAccountOrders, resolveAccountOrderStatus, accountTicketItemCount } from '@/lib/account/portal-orders-and-tickets';
import { getStoreItemsForEvents } from '@/lib/store/get-store-items';
import { buildAccountHomeTicketCards } from '@/lib/account/home-ticket-cards';
import { resolveAccountHomeQrHref, resolveAccountHomeTicketCta, resolveHomeFeaturedEventCta } from '@/lib/account/home-ticket-cta';
import { getLoyaltyLevel, normalizeLoyaltyLevel, sortLoyaltyLevels } from '@/lib/account/levels';
import { resolveTicketPresentationMode } from '@/lib/checkout/ticket-presentation';
import {
  resolveParticipantAvatarUrl,
  resolveParticipantFirstName,
  resolveParticipantFullName,
  resolveParticipantInitials,
} from '@/lib/account/participant-identity';
import { canContinueCommercialPayment } from '@/lib/dashboard/commercial-status';
import { getPrimaryAccountHeaderEvent } from '@/lib/account/header-event';
import { MilitrinAvatar, MilitrinStatusBadge, cx, militrinType } from '@/components/militrin';
import { BetaFeedbackWidget } from '@/components/feedback/BetaFeedbackWidget';
import { HomeTicketCarousel } from './home-ticket-carousel';
import { HomeSponsorsCarousel, type HomeSponsor } from './home-sponsors-carousel';
import { HomeIndicators } from './home-indicators';
import { HomeFeaturedEvents, type HomeFeaturedEvent } from './home-featured-events';
import { HomeFeaturedHero } from './home-featured-hero';
import { HomeQuickActions } from './home-quick-actions';
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

  const [profileResult, ordersResult, eventsResult, featuredEventsResult, loyaltyTiersResult, confirmedOrdersCountResult, sponsorsResult, headerEvent] = await Promise.all([
    supabase.rpc('get_customer_profile', { p_user_id: user?.id ?? null }),
    getAccountOrders(supabase, user?.id ?? ''),
    supabase
      .from('events')
      .select('id, name, slug, starts_at, ends_at, location, registration_enabled, registration_open_at, registration_close_at')
      .eq('registration_enabled', true)
      .order('starts_at', { ascending: true, nullsFirst: false }),
    supabase.rpc('get_featured_events_for_dashboard'),
    supabase.from('loyalty_tiers').select('id, slug, name, badge, min_confirmed_participations, sort_order').order('min_confirmed_participations', { ascending: true }).order('sort_order', { ascending: true }),
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('user_id', user?.id ?? '').eq('status', 'confirmed'),
    supabase.rpc('get_active_sponsors_for_home'),
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
  const greetingInitials = resolveParticipantInitials(displayName);
  const profilePhotoUrl = resolveParticipantAvatarUrl({ profile, userMetadata });

  const loyaltyLevels = sortLoyaltyLevels((loyaltyTiersResult.data ?? []).map((level) => normalizeLoyaltyLevel(level as Record<string, unknown>)));
  const confirmedParticipations = Number(confirmedOrdersCountResult.count ?? 0);
  const currentLoyaltyLevel = getLoyaltyLevel(confirmedParticipations, loyaltyLevels);

  const sponsorRows = (sponsorsResult.data ?? []) as Array<{ sponsor_id: string; name: string; banner_url: string | null; link_url: string | null; carousel_interval_seconds: number | null }>;
  const sponsors: HomeSponsor[] = sponsorRows
    .filter((row) => Boolean(row.banner_url))
    .map((row) => ({ id: String(row.sponsor_id), name: String(row.name), bannerUrl: String(row.banner_url), linkUrl: row.link_url ? String(row.link_url) : null }));
  const sponsorCarouselIntervalSeconds = Number(sponsorRows[0]?.carousel_interval_seconds ?? 4);

  const pendingOrder = orders.find((order) => canContinueCommercialPayment(resolveAccountOrderStatus(order))) ?? null;
  const latestOrder = orders[0] ?? null;
  const latestOrderEvent = latestOrder
    ? firstRelation(latestOrder.events as Record<string, unknown> | Record<string, unknown>[] | null | undefined)
    : null;
  const latestOrderItemCount = latestOrder ? accountTicketItemCount(latestOrder) : 0;
  const latestOrderStatus = latestOrder ? resolveAccountOrderStatus(latestOrder) : null;
  const latestOrderActivityTitle = latestOrderStatus === 'confirmed' ? 'Compra realizada' : 'Pedido criado';

  const ticketCards = await buildAccountHomeTicketCards(supabase, activeTickets);
  const ticketCta = resolveAccountHomeTicketCta(ticketCards);
  const qrHref = resolveAccountHomeQrHref(ticketCta);
  const featuredHeroCta = headerEvent
    ? resolveHomeFeaturedEventCta({
      featuredEventId: headerEvent.id,
      showBuyButton: Boolean(headerEvent.showBuyButton),
      buyHref: headerEvent.buyHref ?? '/minha-conta/comprar',
      tickets: ticketCards,
    })
    : null;

  const storeItems = ticketScope.ownedEventIds.length > 0
    ? await getStoreItemsForEvents(supabase, ticketScope.ownedEventIds)
    : [];
  const storeImageUrls = storeItems.map((item) => item.imageUrl).filter((url): url is string => Boolean(url)).slice(0, 3);

  const listedEvents = dashboardEvents.slice(0, 2);
  const listedEventIds = listedEvents.map((event) => String(event.id)).filter(Boolean);
  const [bannerRowsResult, ...categoryResults] = await Promise.all([
    listedEventIds.length > 0
      ? supabase.from('events').select('id, banner_card_url, banner_hero_url').in('id', listedEventIds)
      : Promise.resolve({ data: [] as Array<{ id: string; banner_card_url: string | null; banner_hero_url: string | null }> }),
    ...listedEvents.map((event) => (
      event?.id
        ? supabase.rpc('get_event_ticket_categories', { p_event_id: event.id })
        : Promise.resolve({ data: null })
    )),
  ]);
  const bannersById = new Map(
    ((bannerRowsResult.data ?? []) as Array<{ id: string; banner_card_url: string | null; banner_hero_url: string | null }>).map((row) => [String(row.id), row]),
  );
  const cardEventsRaw = listedEvents.map((event, index) => {
    const categoriesData = (Array.isArray(categoryResults[index]?.data) ? categoryResults[index].data : []) as Array<{ confirmed_count?: number; capacity?: number | null }>;
    const lowestAmount = findInitialPrice(categoriesData as Array<Record<string, unknown>>);
    const totalCapacity = categoriesData.reduce((sum, row) => sum + (Number.isFinite(Number(row.capacity)) ? Number(row.capacity) : 0), 0);
    const totalConfirmed = categoriesData.reduce((sum, row) => sum + Number(row.confirmed_count ?? 0), 0);
    const soldPercent = totalCapacity > 0 ? Math.round((totalConfirmed / totalCapacity) * 100) : null;
    const banner = bannersById.get(String(event.id));

    return {
      id: String(event.id),
      name: String(event.name),
      date: event.starts_at ? formatDateBR(String(event.starts_at)) : 'Data a confirmar',
      location: event.location ? String(event.location) : 'Local a confirmar',
      registrationStatus: getRegistrationStatus(event),
      startingPrice: lowestAmount !== null ? money(lowestAmount) : null,
      soldPercent,
      isHot: soldPercent !== null && soldPercent >= 50,
      bannerUrl: banner?.banner_card_url || banner?.banner_hero_url || null,
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
      date: eventObj?.starts_at ? formatDateBR(String(eventObj.starts_at)) : null,
      location: optionalDisplayValue(eventObj?.location),
      quantity: items.length,
      categoryLabel: presentationMode === 'category_visible' ? optionalDisplayValue((categoryNameResult.data as { name: string | null } | null)?.name) : null,
      batchLabel: presentationMode === 'single' ? null : optionalDisplayValue((batchNameResult.data as { name: string | null } | null)?.name),
    };
  })();

  return (
    <section className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 lg:hidden">
            <MilitrinAvatar src={profilePhotoUrl} alt={`Foto do usuário ${displayName}`} initials={greetingInitials} size="sm" />
            <p className="min-w-0 truncate text-xs text-slate-400">{String(user?.email ?? '')}</p>
          </div>
          <h1 className={cx('mt-2 lg:mt-0', militrinType.pageTitle)}>Olá, {greetingName}!</h1>
          <p className={cx('mt-1', militrinType.bodyMuted)}>Bem-vindo à sua conta Militrin.</p>
        </div>
        <Link
          href="/minha-conta/dados"
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-2xl border border-slate-700 bg-slate-950/70 px-3 text-sm font-semibold text-slate-100 hover:border-slate-500"
        >
          <CircleUserRound size={16} />
          <span className="hidden sm:inline">Ver meu perfil</span>
        </Link>
      </header>

      {headerEvent ? <HomeFeaturedHero event={headerEvent} cta={featuredHeroCta} /> : null}

      <HomeQuickActions
        qrHref={qrHref}
        hasAccessibleTicket={Boolean(ticketCta)}
        purchaseCount={orders.length}
        activeTicketCount={activeTickets.length}
      />

      <div className={sponsors.length > 0 ? 'grid gap-5 xl:grid-cols-[1.4fr_1fr]' : 'grid gap-5'}>
        <section className="rounded-[1.75rem] border border-slate-800/80 bg-slate-900/70 p-4 shadow-lg shadow-black/10 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={cx('flex items-center gap-2', militrinType.sectionTitle)}>
              <TicketIcon size={18} className="text-(--brand-300)" />Meus acessos
            </h2>
            {ticketCards.length > 0 || archivedTicketCount > 0 ? (
              <Link href="/minha-conta/ingressos" className="inline-flex min-h-11 items-center gap-1 rounded-full border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-slate-500">
                Ver todos<ChevronRight size={13} />
              </Link>
            ) : null}
          </div>
          <div className="mt-4">
            <HomeTicketCarousel
              tickets={ticketCards}
              emptyTitle={archivedTicketCount > 0 ? 'Você não possui ingressos ativos.' : undefined}
              emptyDescription={archivedTicketCount > 0 ? 'Ingressos de eventos encerrados ou cancelados ficam em anteriores e inativos.' : undefined}
              emptyHref={archivedTicketCount > 0 ? '/minha-conta/ingressos?ver=anteriores' : undefined}
              emptyLabel={archivedTicketCount > 0 ? `Anteriores e inativos (${archivedTicketCount})` : undefined}
            />
          </div>
        </section>

        {sponsors.length > 0 ? (
          <section className="rounded-[1.75rem] border border-slate-800/80 bg-slate-900/70 p-4 shadow-lg shadow-black/10 sm:p-5">
            <h2 className={cx('flex items-center gap-2', militrinType.sectionTitle)}>
              <ShieldCheck size={17} className="text-(--brand-300)" />Patrocinadores
            </h2>
            <div className="mt-4">
              <HomeSponsorsCarousel sponsors={sponsors} intervalSeconds={sponsorCarouselIntervalSeconds} />
            </div>
          </section>
        ) : null}
      </div>

      {pendingOrder && pendingOrderDetail ? (
        <HomePendingPurchase
          orderId={String(pendingOrder.id)}
          eventName={pendingOrderDetail.eventName}
          quantity={pendingOrderDetail.quantity}
          categoryLabel={pendingOrderDetail.categoryLabel}
          batchLabel={pendingOrderDetail.batchLabel}
          date={pendingOrderDetail.date}
          location={pendingOrderDetail.location}
          amount={Number(pendingOrder.final_amount ?? 0)}
        />
      ) : null}

      <HomeStoreBanner imageUrls={storeImageUrls} />

      <section className="rounded-[1.75rem] border border-slate-800/80 bg-slate-900/70 p-4 shadow-lg shadow-black/10 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={militrinType.sectionTitle}>Eventos em destaque</h2>
          <Link href="/eventos" className="inline-flex min-h-11 items-center gap-1 rounded-full border border-slate-700 bg-slate-950/60 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:border-slate-500">
            Ver todos<ChevronRight size={13} />
          </Link>
        </div>
        <div className="mt-4">
          <HomeFeaturedEvents events={cardEventsRaw} />
        </div>
      </section>

      <HomeIndicators
        purchaseCount={orders.length}
        activeTicketCount={activeTickets.length}
        categoryName={String(currentLoyaltyLevel.name)}
      />

      {latestOrder ? (
        <section className="rounded-[1.75rem] border border-slate-800/80 bg-slate-900/70 p-4 shadow-lg shadow-black/10 sm:p-5">
          <h2 className={cx('flex items-center gap-2', militrinType.sectionTitle)}>
            <Clock size={17} className="text-(--brand-300)" />Últimas novidades
          </h2>
          <Link
            href={`/minha-conta/compras/${latestOrder.id}`}
            className="mt-4 flex flex-col gap-2 rounded-2xl border border-slate-800 bg-slate-950/50 p-3 transition hover:border-slate-600 sm:flex-row sm:items-center sm:gap-3"
          >
            <span className="flex min-w-0 items-center gap-3 sm:flex-1">
              <span className="min-w-0 flex-1">
                <span className={cx('block', militrinType.cardTitle)}>{latestOrderActivityTitle}</span>
                <span className={cx('block truncate', militrinType.micro)}>
                  {latestOrderEvent?.name ? String(latestOrderEvent.name) : 'Evento'}
                  {latestOrderItemCount > 0 ? ` - ${latestOrderItemCount} ingresso${latestOrderItemCount === 1 ? '' : 's'}` : ''}
                </span>
              </span>
            </span>
            <span className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
              <MilitrinStatusBadge status={String(latestOrderStatus)} />
              <span className={cx('shrink-0', militrinType.micro)}>{formatDateTimeBR(String(latestOrder.confirmed_at ?? latestOrder.created_at ?? ''), ' ')}</span>
              <ChevronRight size={16} className="shrink-0 text-slate-500" />
            </span>
          </Link>
        </section>
      ) : null}

      <BetaFeedbackWidget />
    </section>
  );
}
