import type { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatCompactEventWhen, formatDateBR } from '@/lib/utils/date';
import { resolveTicketPresentationMode } from '@/lib/checkout/ticket-presentation';
import { optionalDisplayValue } from '@/lib/optional-display';
import { getEventTicketCategories } from '@/lib/account/event-ticket-categories';
import { getOpenParticipantIssues } from '@/lib/account/participant-open-issues';
import type { AccountHomeEventRow } from '@/lib/account/home-events';

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export type AccountHomeTicketCard = {
  ticketId: string;
  orderId: string | null;
  eventId: string | null;
  eventName: string;
  date: string | null;
  compactDate: string | null;
  location: string | null;
  bannerUrl: string | null;
  status: string;
  holderName: string | null;
  /** Token operacional do ticket -- so preenchido quando o QR pode ser exibido. */
  token: string | null;
  /** null quando resolveTicketPresentationMode manda esconder a categoria (0 ou 1 categoria ativa no evento). */
  categoryLabel: string | null;
  batchLabel: string | null;
  /** "Camiseta P", "Baby look M" etc. -- null quando o item nao tem camiseta. */
  shirtLabel: string | null;
  canShowTicket: boolean;
};

export type AccountHomeTicketCardOrderItem = {
  id: string;
  participant_id: string | null;
  ticket_category_id: string | null;
  batch_id: string | null;
  shirt_type: string | null;
  shirt_size: string | null;
  holder_full_name: string | null;
};

export type AccountHomeTicketCardOrder = {
  id: string;
  status: string | null;
};

export type AccountHomeTicketCardSources = {
  orderItems?: AccountHomeTicketCardOrderItem[];
  orders?: AccountHomeTicketCardOrder[];
  events?: Array<Pick<AccountHomeEventRow, 'id' | 'name' | 'starts_at' | 'location' | 'banner_card_url' | 'banner_hero_url'>>;
};

function uniq(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function resolved<T>(data: T) {
  return Promise.resolve({ data, error: null });
}

/**
 * Monta os cards de ingresso do carrossel da Home a partir dos tickets
 * canonicos ja resolvidos por getAccessibleTicketScope (o mesmo escopo usado
 * por /minha-conta/ingressos). Categoria/lote seguem resolveTicketPresentationMode
 * -- a mesma regra do checkout publico -- nunca uma aproximacao visual.
 *
 * Fontes opcionais (`sources`) reutilizam dados ja carregados no mesmo request
 * (order_items, orders, events). Sem cache persistente.
 */
export async function buildAccountHomeTicketCards(
  supabase: ServerSupabaseClient,
  tickets: Array<{
    id: string;
    status: string | null;
    token?: string | null;
    order_id: string | null;
    order_item_id: string | null;
    event_id: string | null;
  }>,
  sources: AccountHomeTicketCardSources = {},
): Promise<AccountHomeTicketCard[]> {
  if (tickets.length === 0) return [];

  const orderItemIds = uniq(tickets.map((ticket) => ticket.order_item_id));
  const orderIds = uniq(tickets.map((ticket) => ticket.order_id));
  const eventIds = uniq(tickets.map((ticket) => ticket.event_id));

  const [itemsResult, ordersResult, eventsResult] = await Promise.all([
    sources.orderItems
      ? resolved(sources.orderItems)
      : orderItemIds.length > 0
        ? supabase.from('order_items').select('id, participant_id, ticket_category_id, batch_id, shirt_type, shirt_size, holder_full_name').in('id', orderItemIds)
        : resolved([]),
    sources.orders
      ? resolved(sources.orders)
      : orderIds.length > 0
        ? supabase.from('orders').select('id, status').in('id', orderIds)
        : resolved([]),
    sources.events
      ? resolved(sources.events)
      : eventIds.length > 0
        ? supabase.from('events').select('id, name, starts_at, location, banner_card_url, banner_hero_url').in('id', eventIds)
        : resolved([]),
  ]);

  const items = (itemsResult.data ?? []) as AccountHomeTicketCardOrderItem[];
  const orders = (ordersResult.data ?? []) as AccountHomeTicketCardOrder[];
  const events = (eventsResult.data ?? []) as Array<{ id: string; name: string | null; starts_at: string | null; location: string | null; banner_card_url: string | null; banner_hero_url: string | null }>;

  const participantIds = uniq(items.map((item) => item.participant_id));
  const categoryIds = uniq(items.map((item) => item.ticket_category_id));
  const batchIds = uniq(items.map((item) => item.batch_id));

  const [openIssues, categoriesResult, batchesResult] = await Promise.all([
    getOpenParticipantIssues(participantIds),
    categoryIds.length > 0
      ? supabase.from('ticket_categories').select('id, name').in('id', categoryIds)
      : resolved([]),
    batchIds.length > 0
      ? supabase.from('registration_batches').select('id, name').in('id', batchIds)
      : resolved([]),
  ]);

  const activeCategoryCountByEvent = new Map<string, number>();
  await Promise.all(eventIds.map(async (eventId) => {
    const { data } = await getEventTicketCategories(eventId);
    const rows = (data ?? []) as Array<{ is_active: boolean; available_slots: number | null; current_batch_name: string | null }>;
    const activeCount = rows.filter((row) => row.is_active && (row.available_slots === null || row.available_slots > 0) && row.current_batch_name !== null).length;
    activeCategoryCountByEvent.set(eventId, activeCount);
  }));

  const itemsById = new Map(items.map((item) => [item.id, item]));
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const categoriesById = new Map(categoriesResult.data?.map((row) => [row.id, row.name]) ?? []);
  const batchesById = new Map(batchesResult.data?.map((row) => [row.id, row.name]) ?? []);
  const blockedParticipantIds = new Set(
    openIssues.filter((issue) => Boolean(issue.blocks_ticket_issuance)).map((issue) => String(issue.participant_id ?? '')),
  );

  return tickets.map((ticket) => {
    const item = itemsById.get(String(ticket.order_item_id ?? ''));
    const order = ordersById.get(String(ticket.order_id ?? ''));
    const eventObj = eventsById.get(String(ticket.event_id ?? ''));
    const eventId = String(ticket.event_id ?? '');
    const activeCategoryCount = activeCategoryCountByEvent.get(eventId) ?? 0;
    const presentationMode = resolveTicketPresentationMode(activeCategoryCount);
    const categoryName = item ? optionalDisplayValue(categoriesById.get(String(item.ticket_category_id ?? ''))) : null;
    const batchName = item ? optionalDisplayValue(batchesById.get(String(item.batch_id ?? ''))) : null;
    const orderStatus = String(order?.status ?? 'pending');
    const ticketIssuanceBlocked = item ? blockedParticipantIds.has(String(item.participant_id ?? '')) : false;
    const canShowTicket = !ticketIssuanceBlocked && orderStatus === 'confirmed' && (ticket.status === 'active' || ticket.status === 'used');
    const shirtType = optionalDisplayValue(item?.shirt_type ?? null);
    const shirtSize = optionalDisplayValue(item?.shirt_size ?? null);
    const shirtLabel = shirtType && shirtSize ? `${shirtType} ${shirtSize}` : shirtType || shirtSize;
    const canShowQr = canShowTicket && Boolean(String(ticket.token ?? '').trim());

    return {
      ticketId: ticket.id,
      orderId: order?.id ?? null,
      eventId: eventId || null,
      eventName: eventObj?.name ? String(eventObj.name) : 'Evento Militrin',
      date: eventObj?.starts_at ? formatDateBR(eventObj.starts_at) : null,
      compactDate: eventObj?.starts_at ? (formatCompactEventWhen(eventObj.starts_at, null)?.split(' · ')[0] ?? null) : null,
      location: optionalDisplayValue(eventObj?.location),
      bannerUrl: eventObj?.banner_card_url || eventObj?.banner_hero_url || null,
      status: String(ticket.status ?? 'pending'),
      holderName: optionalDisplayValue(item?.holder_full_name ?? null),
      token: canShowQr ? String(ticket.token) : null,
      categoryLabel: presentationMode === 'category_visible' ? categoryName : null,
      batchLabel: presentationMode === 'single' ? null : batchName,
      shirtLabel: shirtLabel ?? null,
      canShowTicket,
    };
  });
}
