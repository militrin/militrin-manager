import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, CalendarDays, ChevronRight, Clock, QrCode, ShieldCheck, ShoppingBag, Store, Ticket as TicketIcon } from 'lucide-react';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR, formatDateTimeBR } from '@/lib/utils/date';
import { optionalDisplayValue } from '@/lib/optional-display';
import { getAccessibleTicketScope, getAccountOrders } from '@/lib/account/portal-orders-and-tickets';
import { getStoreItemsForEvents } from '@/lib/store/get-store-items';
import { buildAccountHomeTicketCards } from '@/lib/account/home-ticket-cards';
import { resolveAccountHomeTicketCta } from '@/lib/account/home-ticket-cta';
import { getLoyaltyLevel, normalizeLoyaltyLevel, sortLoyaltyLevels } from '@/lib/account/levels';
import { resolveTicketPresentationMode } from '@/lib/checkout/ticket-presentation';
import {
  resolveParticipantAvatarUrl,
  resolveParticipantFirstName,
  resolveParticipantFullName,
  resolveParticipantInitials,
} from '@/lib/account/participant-identity';
import { MilitrinAvatar, MilitrinLinkButton, MilitrinSection, MilitrinStatusBadge, cx, militrinType } from '@/components/militrin';
import { BetaFeedbackWidget } from '@/components/feedback/BetaFeedbackWidget';
import { HomeTicketCarousel } from './home-ticket-carousel';
import { HomeSponsorsCarousel, type HomeSponsor } from './home-sponsors-carousel';
import { HomeIndicators } from './home-indicators';
import { HomeFeaturedEvents, type HomeFeaturedEvent } from './home-featured-events';

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

  const [profileResult, ordersResult, eventsResult, featuredEventsResult, loyaltyTiersResult, confirmedOrdersCountResult, sponsorsResult] = await Promise.all([
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
  const allTickets = ticketScope.tickets;
  const activeTickets = allTickets.filter((ticket) => String(ticket.status ?? '') === 'active');

  const displayName = resolveParticipantFullName({ profile, userMetadata, email: user?.email });
  const greetingName = resolveParticipantFirstName(displayName);
  const greetingInitials = resolveParticipantInitials(displayName);
  const profilePhotoUrl = resolveParticipantAvatarUrl({ profile, userMetadata });

  const loyaltyLevels = sortLoyaltyLevels((loyaltyTiersResult.data ?? []).map((level) => normalizeLoyaltyLevel(level as Record<string, unknown>)));
  const confirmedParticipations = Number(confirmedOrdersCountResult.count ?? 0);
  const currentLoyaltyLevel = getLoyaltyLevel(confirmedParticipations, loyaltyLevels);

  // Sem patrocinadores ativos, a secao inteira some (nunca um card vazio) e
  // "Seus ingressos" volta a ocupar a largura toda -- ver o grid condicional
  // mais abaixo, que so vira 2 colunas quando sponsors.length > 0.
  const sponsorRows = (sponsorsResult.data ?? []) as Array<{ sponsor_id: string; name: string; banner_url: string | null; link_url: string | null; carousel_interval_seconds: number | null }>;
  const sponsors: HomeSponsor[] = sponsorRows
    .filter((row) => Boolean(row.banner_url))
    .map((row) => ({ id: String(row.sponsor_id), name: String(row.name), bannerUrl: String(row.banner_url), linkUrl: row.link_url ? String(row.link_url) : null }));
  const sponsorCarouselIntervalSeconds = Number(sponsorRows[0]?.carousel_interval_seconds ?? 4);

  const pendingOrder = orders.find((order) => order.status === 'pending') ?? null;
  const latestOrder = orders[0] ?? null;
  const latestOrderEvent = latestOrder
    ? firstRelation(latestOrder.events as Record<string, unknown> | Record<string, unknown>[] | null | undefined)
    : null;
  const latestOrderItemCount = latestOrder && Array.isArray(latestOrder.order_items) ? latestOrder.order_items.length : 0;
  const latestOrderActivityTitle = latestOrder?.status === 'confirmed' ? 'Compra realizada' : 'Pedido criado';

  const ticketCards = await buildAccountHomeTicketCards(supabase, allTickets as Array<{ id: string; status: string | null; order_id: string | null; order_item_id: string | null; event_id: string | null }>);
  const ticketCta = resolveAccountHomeTicketCta(ticketCards);

  // Card de destaque "Loja Militrin" na home: imagem de um item real (mesma
  // fonte que a pagina /minha-conta/loja usa -- eventos aos quais o usuario
  // realmente tem ingresso), nunca uma imagem generica desconectada do
  // catalogo de verdade.
  const storeHighlightItem = ticketScope.ownedEventIds.length > 0
    ? (await getStoreItemsForEvents(supabase, ticketScope.ownedEventIds)).find((item) => item.imageUrl) ?? null
    : null;

  const cardEventsRaw = await Promise.all(dashboardEvents.slice(0, 2).map(async (event) => {
    const [categoriesRpc, bannerResult] = await Promise.all([
      event?.id ? supabase.rpc('get_event_ticket_categories', { p_event_id: event.id }) : Promise.resolve({ data: null }),
      event?.id ? supabase.from('events').select('banner_card_url, banner_hero_url').eq('id', event.id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    const categoriesData = (Array.isArray(categoriesRpc.data) ? categoriesRpc.data : []) as Array<{ confirmed_count?: number; capacity?: number | null }>;
    const lowestAmount = findInitialPrice(categoriesData as Array<Record<string, unknown>>);
    const totalCapacity = categoriesData.reduce((sum, row) => sum + (Number.isFinite(Number(row.capacity)) ? Number(row.capacity) : 0), 0);
    const totalConfirmed = categoriesData.reduce((sum, row) => sum + Number(row.confirmed_count ?? 0), 0);
    const soldPercent = totalCapacity > 0 ? Math.round((totalConfirmed / totalCapacity) * 100) : null;
    const banner = bannerResult.data as { banner_card_url: string | null; banner_hero_url: string | null } | null;

    return {
      id: String(event.id),
      name: String(event.name),
      date: event.starts_at ? formatDateBR(String(event.starts_at)) : 'Data a confirmar',
      location: event.location ? String(event.location) : 'Local a confirmar',
      registrationStatus: getRegistrationStatus(event),
      startingPrice: lowestAmount !== null ? money(lowestAmount) : null,
      soldPercent,
      bannerUrl: banner?.banner_card_url || banner?.banner_hero_url || null,
      buyHref: event.slug ? `/inscricao/${event.slug}` : '/minha-conta/comprar',
    } satisfies HomeFeaturedEvent;
  }));

  // Detalhe da compra pendente (categoria/lote): so busca quando existe pedido
  // pendente, seguindo a mesma regra adaptativa (resolveTicketPresentationMode)
  // usada no restante do portal.
  const pendingOrderDetail = await (async () => {
    if (!pendingOrder) return null;
    const eventObj = firstRelation(pendingOrder.events as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
    const eventId = String(pendingOrder.event_id ?? '');
    const [itemsResult, categoriesRpc] = await Promise.all([
      supabase.from('order_items').select('ticket_category_id, batch_id').eq('order_id', String(pendingOrder.id)),
      eventId ? supabase.rpc('get_event_ticket_categories', { p_event_id: eventId }) : Promise.resolve({ data: null }),
    ]);
    const items = (itemsResult.data ?? []) as Array<{ ticket_category_id: string | null; batch_id: string | null }>;
    const firstItem = items[0] ?? null;
    const categoryRows = (Array.isArray(categoriesRpc.data) ? categoriesRpc.data : []) as Array<{ is_active: boolean; available_slots: number | null; current_batch_name: string | null }>;
    const activeCategoryCount = categoryRows.filter((row) => row.is_active && (row.available_slots === null || row.available_slots > 0) && row.current_batch_name !== null).length;
    const presentationMode = resolveTicketPresentationMode(activeCategoryCount);

    const [categoryNameResult, batchNameResult] = await Promise.all([
      firstItem?.ticket_category_id ? supabase.from('ticket_categories').select('name').eq('id', firstItem.ticket_category_id).maybeSingle() : Promise.resolve({ data: null }),
      firstItem?.batch_id ? supabase.from('registration_batches').select('name').eq('id', firstItem.batch_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);

    return {
      eventName: eventObj?.name ? String(eventObj.name) : 'Evento Militrin',
      date: eventObj?.starts_at ? formatDateBR(String(eventObj.starts_at)) : null,
      location: optionalDisplayValue(eventObj?.location),
      quantity: items.length,
      categoryLabel: presentationMode === 'category_visible' ? optionalDisplayValue((categoryNameResult.data as { name: string | null } | null)?.name) : null,
      batchLabel: presentationMode === 'single' ? null : optionalDisplayValue((batchNameResult.data as { name: string | null } | null)?.name),
    };
  })();

  return (
    <section className="space-y-5">
      <MilitrinSection
        size="compact"
        title={`Olá, ${greetingName}!`}
        className="relative isolate overflow-hidden"
        action={
          ticketCta ? (
            <Link
              href={ticketCta.type === 'ticket' ? `/minha-conta/ingressos/${ticketCta.ticketId}` : '/minha-conta/ingressos'}
              className="inline-flex items-center gap-2.5 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 transition hover:bg-emerald-500/15"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-500/40 bg-slate-950">
                <QrCode size={17} className="text-emerald-300" />
              </span>
              <span className="min-w-0">
                <span className="block text-[11px] text-slate-300">{ticketCta.type === 'ticket' ? 'Acesse seu ingresso' : 'Acesse seus ingressos'}</span>
                <span className="flex items-center gap-1 text-sm font-bold text-emerald-300">{ticketCta.type === 'ticket' ? 'Ver QR Code' : 'Ver ingressos'}<ChevronRight size={13} /></span>
              </span>
            </Link>
          ) : null
        }
      >
        <div aria-hidden className="mask-logo pointer-events-none absolute -right-10 -top-8 -z-10 hidden h-48 w-48 rotate-6 opacity-20 md:block" />
        <div className="flex items-center gap-2.5">
          <MilitrinAvatar src={profilePhotoUrl} alt={`Foto do usuário ${displayName}`} initials={greetingInitials} size="sm" />
          <p className="min-w-0 truncate text-xs text-slate-400" title={String(user?.email ?? '')}>{String(user?.email ?? '')}</p>
        </div>
      </MilitrinSection>

      {/* Descoberta/compra em destaque: Eventos e Loja precisam ser
          encontrados em poucos cliques a partir da home, alem de estarem na
          bottom nav mobile -- ver AJUSTE MOBILE item 2. Imagem real (banner
          do evento em destaque / foto de um item real da loja) quando
          disponivel, gradiente de marca como fallback -- nunca um card vazio. */}
      <div className="grid grid-cols-2 gap-3">
        <Link
          href="/minha-conta/comprar"
          className="group relative isolate flex min-h-27 flex-col justify-end overflow-hidden rounded-[1.75rem] border border-slate-800/80 p-3.5 shadow-lg shadow-black/10 transition hover:border-(--brand-400)/50 sm:min-h-34"
        >
          {cardEventsRaw[0]?.bannerUrl ? (
            <Image src={cardEventsRaw[0].bannerUrl} alt="" fill unoptimized className="-z-20 object-cover opacity-80 transition group-hover:opacity-90" />
          ) : (
            <div aria-hidden className="absolute inset-0 -z-20 bg-linear-to-br from-(--brand-600)/50 to-slate-950" />
          )}
          <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-t from-slate-950 via-slate-950/65 to-transparent" />
          <span className="inline-flex w-fit items-center gap-1.5 text-(--brand-300)">
            <CalendarDays size={15} />
            <span className={cx(militrinType.label, 'text-(--brand-200)')}>Próximos eventos</span>
          </span>
          <span className="mt-1 flex items-center gap-1 text-sm font-bold text-white">Ver eventos<ArrowRight size={14} /></span>
        </Link>

        <Link
          href="/minha-conta/loja"
          className="group relative isolate flex min-h-27 flex-col justify-end overflow-hidden rounded-[1.75rem] border border-slate-800/80 p-3.5 shadow-lg shadow-black/10 transition hover:border-amber-400/50 sm:min-h-34"
        >
          {storeHighlightItem?.imageUrl ? (
            <Image src={storeHighlightItem.imageUrl} alt="" fill unoptimized className="-z-20 object-cover opacity-80 transition group-hover:opacity-90" />
          ) : (
            <div aria-hidden className="absolute inset-0 -z-20 bg-linear-to-br from-amber-500/40 to-slate-950" />
          )}
          <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-t from-slate-950 via-slate-950/65 to-transparent" />
          <span className="inline-flex w-fit items-center gap-1.5 text-amber-300">
            <Store size={15} />
            <span className={cx(militrinType.label, 'text-amber-200')}>Loja Militrin</span>
          </span>
          <span className="mt-1 flex items-center gap-1 text-sm font-bold text-white">Ir para a loja<ArrowRight size={14} /></span>
        </Link>
      </div>

      <div className={sponsors.length > 0 ? 'grid gap-5 xl:grid-cols-[1fr_1fr]' : 'grid gap-5'}>
        <section className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-black/10 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={cx('flex items-center gap-2', militrinType.sectionTitle)}>
              <TicketIcon size={18} className="text-(--brand-300)" />Seus ingressos
            </h2>
            {ticketCards.length > 0 ? (
              <Link href="/minha-conta/ingressos" className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-950/60 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-slate-500">
                Ver todos<ChevronRight size={13} />
              </Link>
            ) : null}
          </div>
          <div className="mt-4">
            <HomeTicketCarousel tickets={ticketCards} />
          </div>
        </section>

        {sponsors.length > 0 ? (
          <section className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-black/10 sm:p-6">
            <h2 className={cx('flex items-center gap-2', militrinType.sectionTitle)}>
              <ShieldCheck size={17} className="text-(--brand-300)" />Patrocinadores
            </h2>
            <div className="mt-4">
              <HomeSponsorsCarousel sponsors={sponsors} intervalSeconds={sponsorCarouselIntervalSeconds} />
            </div>
          </section>
        ) : null}
      </div>

      <HomeIndicators
        purchaseCount={orders.length}
        activeTicketCount={activeTickets.length}
        categoryName={String(currentLoyaltyLevel.name)}
      />

      <div className="grid gap-5 xl:grid-cols-[2fr_1fr]">
        <section className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-black/10 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className={cx('flex items-center gap-2', militrinType.sectionTitle)}>
              <ShoppingBag size={17} className="text-(--brand-300)" />Eventos em destaque
            </h2>
            <Link href="/eventos" className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-950/60 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-slate-500">
              Ver todos<ChevronRight size={13} />
            </Link>
          </div>
          <div className="mt-4">
            <HomeFeaturedEvents events={cardEventsRaw} />
          </div>
        </section>

        <section className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-black/10 sm:p-6">
          <h2 className={cx('flex items-center gap-2', militrinType.sectionTitle)}>
            <ShoppingBag size={17} className="text-amber-300" />Compra pendente
          </h2>
          {pendingOrder && pendingOrderDetail ? (
            <div className="mt-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <p className={militrinType.cardTitle}>{pendingOrderDetail.eventName}</p>
                <MilitrinStatusBadge status="pending" />
              </div>
              <div className={cx('flex flex-wrap gap-x-4 gap-y-1', militrinType.micro)}>
                {pendingOrderDetail.date ? <span>{pendingOrderDetail.date}</span> : null}
                {pendingOrderDetail.location ? <span>{pendingOrderDetail.location}</span> : null}
              </div>
              <p className={militrinType.micro}>
                {pendingOrderDetail.quantity} ingresso{pendingOrderDetail.quantity === 1 ? '' : 's'}
                {pendingOrderDetail.categoryLabel ? ` · ${pendingOrderDetail.categoryLabel}` : ''}
              </p>
              {pendingOrderDetail.batchLabel ? <p className={militrinType.micro}>{pendingOrderDetail.batchLabel}</p> : null}
              <p className={cx('pt-1 text-2xl', militrinType.money)}>{money(Number(pendingOrder.final_amount ?? 0))}</p>
              <MilitrinLinkButton href={`/minha-conta/compras/${pendingOrder.id}`} size="md" className="mt-3 w-full">
                Continuar pagamento
              </MilitrinLinkButton>
            </div>
          ) : (
            <p className={cx('mt-4', militrinType.bodyMuted)}>Nenhuma compra pendente no momento.</p>
          )}
        </section>
      </div>

      <section className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-black/10 sm:p-6">
        <h2 className={cx('flex items-center gap-2', militrinType.sectionTitle)}>
          <Clock size={17} className="text-(--brand-300)" />Última atividade
        </h2>
        {latestOrder ? (
          <Link
            href={`/minha-conta/compras/${latestOrder.id}`}
            className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/50 p-3 transition hover:border-slate-600 sm:flex-nowrap"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-(--brand-500)/15 text-(--brand-300)">
              <ShoppingBag size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={cx('block', militrinType.cardTitle)}>{latestOrderActivityTitle}</span>
              <span className={cx('block truncate', militrinType.micro)}>
                {latestOrderEvent?.name ? String(latestOrderEvent.name) : 'Evento Militrin'}
                {latestOrderItemCount > 0 ? ` - ${latestOrderItemCount} ingresso${latestOrderItemCount === 1 ? '' : 's'}` : ''}
              </span>
            </span>
            <span className="shrink-0"><MilitrinStatusBadge status={String(latestOrder.status)} /></span>
            <span className={cx('shrink-0', militrinType.micro)}>{formatDateTimeBR(String(latestOrder.confirmed_at ?? latestOrder.created_at ?? ''), ' ')}</span>
            <span className={cx('shrink-0', militrinType.money)}>{money(Number(latestOrder.final_amount ?? 0))}</span>
            <ChevronRight size={16} className="shrink-0 text-slate-500" />
          </Link>
        ) : (
          <p className={cx('mt-4', militrinType.bodyMuted)}>Seu primeiro pedido aparecerá aqui.</p>
        )}
      </section>

      <BetaFeedbackWidget />
    </section>
  );
}
