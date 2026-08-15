import Link from 'next/link';
import { Medal, QrCode, ShoppingBag, Ticket, UserRound } from 'lucide-react';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR, formatDateTimeBR } from '@/lib/utils/date';
import { getStatusLabel } from '@/lib/status-labels';
import { getAccessibleTicketScope, getAccountOrders } from '@/lib/account/portal-orders-and-tickets';
import { getAccountEventSchedule } from '@/lib/account/event-schedule';
import {
  resolveParticipantAvatarUrl,
  resolveParticipantFirstName,
  resolveParticipantFullName,
  resolveParticipantInitials,
} from '@/lib/account/participant-identity';
import {
  MilitrinAvatar,
  MilitrinButton,
  MilitrinEmptyState,
  MilitrinEventCard,
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

export default async function MinhaContaPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [profileResult, ordersResult, eventsResult, featuredEventsResult] = await Promise.all([
    supabase.rpc('get_customer_profile', { p_user_id: user?.id ?? null }),
    getAccountOrders(supabase, user?.id ?? ''),
    supabase
      .from('events')
      .select('id, name, slug, starts_at, ends_at, location, registration_enabled, registration_open_at, registration_close_at')
      .eq('registration_enabled', true)
      .order('starts_at', { ascending: true, nullsFirst: false }),
    supabase.rpc('get_featured_events_for_dashboard'),
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
  const scheduleResult = await getAccountEventSchedule(supabase, ticketScope.ownedEventIds, { limit: 4 });
  if (scheduleResult.error) console.error('[minha-conta] erro ao carregar cronograma dos eventos', scheduleResult.error);

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
  const eventSchedule = scheduleResult.data;
  const allTickets = ticketScope.tickets;
  const activeTickets = allTickets.filter((ticket) => String(ticket.status ?? '') === 'active');
  const highlightedTicket = allTickets.find((ticket) => {
    const status = String(ticket.status ?? '').toLowerCase();
    return status === 'active' || status === 'used';
  }) ?? null;

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
    ? ticketScope.orders.find((order) => String(order.id ?? '') === String(highlightedTicket.order_id ?? '')) ?? null
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
        description="Bem-vindo à sua conta Militrin."
        className="relative isolate overflow-hidden"
        action={
          highlightedTicket ? (
            <Link href={`/minha-conta/ingressos/${highlightedTicket.id}`}>
              <MilitrinButton iconLeft={<QrCode size={15} />}>Ver QR Code</MilitrinButton>
            </Link>
          ) : null
        }
      >
        <div
          aria-hidden
          className="mask-logo pointer-events-none absolute -right-12 -top-10 -z-10 hidden h-72 w-72 rotate-6 opacity-25 md:block"
        />
        <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
          <article className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
            <p className="text-xs uppercase tracking-[0.2em] text-(--brand-300)">Dados do usuário</p>
            <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-3">
                <MilitrinAvatar src={profilePhotoUrl} alt={`Foto do usuário ${displayName}`} initials={greetingInitials} size="lg" />
                <div className="min-w-0">
                  <p className="truncate text-xl font-semibold text-white" title={displayName} aria-label={displayName}>{displayName}</p>
                  <p className="text-sm text-slate-300">Usuário desde {memberSinceYear}</p>
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <MilitrinStat label="Categoria" value="Em breve" icon={<Medal size={14} />} />
              <MilitrinStat label="Nível" value="Em breve" icon={<Ticket size={14} />} />
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
                  <MilitrinButton iconLeft={<QrCode size={15} />}>Abrir QR Code</MilitrinButton>
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
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Cronograma dos seus eventos</p>
            {eventSchedule.length > 0 ? (
              <div className="mt-3 space-y-3 text-sm text-slate-200">
                {eventSchedule.map((item) => (
                  <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2">
                    <p className="font-semibold text-white">{formatDateTimeBR(item.delivery_at, ' às ')}</p>
                    <p className="mt-1 font-medium text-(--brand-200)">{item.event_name}</p>
                    <p>{item.title}</p>
                    {item.location ? <p className="truncate text-slate-300" title={item.location}>{item.location}</p> : null}
                    {item.description ? <p className="line-clamp-2 text-xs text-slate-400">{item.description}</p> : null}
                  </div>
                ))}
                <Link href="/minha-conta/entregas" className="inline-flex h-10 items-center justify-center rounded-xl border border-(--brand-400)/40 bg-(--brand-500)/10 px-4 text-xs font-semibold text-(--brand-100) transition hover:bg-(--brand-500)/20">
                  Ver cronograma completo
                </Link>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <p className="text-sm text-slate-300">Nenhum compromisso futuro nos seus eventos.</p>
                <Link href="/minha-conta/entregas" className="inline-flex h-10 items-center justify-center rounded-xl border border-(--brand-400)/40 bg-(--brand-500)/10 px-4 text-xs font-semibold text-(--brand-100) transition hover:bg-(--brand-500)/20">
                  Ver cronograma completo
                </Link>
              </div>
            )}
          </article>
        </div>
      </MilitrinSection>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MilitrinStat label="Compras" value={orders.length} icon={<ShoppingBag size={14} />} className="border-slate-800 bg-slate-950/60" />
        <MilitrinStat label="Ingressos ativos" value={activeTickets.length} icon={<Ticket size={14} />} className="border-slate-800 bg-slate-950/60" />
        <MilitrinStat label="Categoria" value="Em breve" icon={<Medal size={14} />} className="border-slate-800 bg-slate-950/60" />
        <MilitrinStat label="Nível" value="Em breve" icon={<Ticket size={14} />} className="border-slate-800 bg-slate-950/60" />
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Link href="/minha-conta/comprar"><MilitrinButton className="w-full" iconLeft={<ShoppingBag size={15} />}>Comprar ingresso</MilitrinButton></Link>
        <Link href="/minha-conta/ingressos"><MilitrinButton className="w-full" variant="secondary" iconLeft={<Ticket size={15} />}>Ver meus ingressos</MilitrinButton></Link>
        <Link href="/minha-conta/compras"><MilitrinButton className="w-full" variant="secondary" iconLeft={<ShoppingBag size={15} />}>Ver compras</MilitrinButton></Link>
        <Link href="/minha-conta/dados"><MilitrinButton className="w-full" variant="secondary" iconLeft={<UserRound size={15} />}>Atualizar perfil</MilitrinButton></Link>
      </section>

      <section className="grid gap-3 xl:grid-cols-2">
        <article className="rounded-[1.75rem] border border-slate-800 bg-slate-950/60 p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Compra pendente</p>
          {pendingOrder ? (
            <div className="mt-3 space-y-2 text-sm text-slate-200">
              <p>Pedido: {String(pendingOrder.order_number ?? '-')}</p>
              <p>Valor: {money(Number(pendingOrder.final_amount ?? 0))}</p>
              <p>Pedido: {getStatusLabel(String(pendingOrder.status))}</p>
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
              <p>Pedido: {getStatusLabel(String(latestOrder.status ?? ''))}</p>
              <Link href={`/minha-conta/compras/${latestOrder.id}`} className="inline-flex h-10 items-center justify-center rounded-xl border border-(--brand-400)/40 bg-(--brand-500)/10 px-4 text-xs font-semibold text-(--brand-100) transition hover:bg-(--brand-500)/20">
                Ver detalhes
              </Link>
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-300">Seu primeiro pedido aparecerá aqui.</p>
          )}
        </article>
      </section>

      {!ticketScope.orderItems.length ? (
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
