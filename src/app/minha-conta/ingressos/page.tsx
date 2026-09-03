import { QrCode } from 'lucide-react';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';
import { MilitrinEmptyState, MilitrinHeader, MilitrinLinkButton, MilitrinTicketCard, cx, militrinTokens, militrinType } from '@/components/militrin';
import { optionalDisplayValue } from '@/lib/optional-display';
import { getAccessibleTicketScope, getAccountOrders } from '@/lib/account/portal-orders-and-tickets';
import { generateQrDataUrl } from '@/lib/qr/generate-qr-data-url';
import { getPrimaryAccountHeaderEvent } from '@/lib/account/header-event';

function normalizeStatus(status: string | null | undefined) {
  const normalized = String(status ?? 'pending').toLowerCase();
  if (normalized === 'paid') return 'confirmed';
  return normalized;
}

export default async function IngressosPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return (
      <section className="rounded-3xl border border-rose-700/40 bg-rose-950/20 p-5 text-sm text-rose-100">
        Erro ao carregar ingressos. Tente novamente em instantes.
      </section>
    );
  }

  const [purchasedOrdersResult, headerEvent] = await Promise.all([
    getAccountOrders(supabase, user.id),
    getPrimaryAccountHeaderEvent(supabase),
  ]);
  if (purchasedOrdersResult.error) {
    console.error('[meus-ingressos] erro ao carregar pedidos do comprador', purchasedOrdersResult.error);
    return (
      <section className="rounded-3xl border border-rose-700/40 bg-rose-950/20 p-5 text-sm text-rose-100">
        Erro ao carregar ingressos. Tente novamente em instantes.
      </section>
    );
  }

  const ticketScope = await getAccessibleTicketScope(
    supabase,
    user.id,
    (purchasedOrdersResult.data ?? []) as Array<Record<string, unknown>>,
  );
  if (ticketScope.error) {
    console.error('[meus-ingressos] erro ao carregar escopo canônico de ingressos', {
      stage: ticketScope.stage,
      error: ticketScope.error,
    });
    return <section className="rounded-3xl border border-rose-700/40 bg-rose-950/20 p-5 text-sm text-rose-100">Erro ao carregar ingressos. Tente novamente em instantes.</section>;
  }

  const orders = ticketScope.orders as Array<{ id: string; order_number: string | null; status: string | null; event_id: string | null; user_id: string | null; buyer_type: 'account' | 'imported_holder' | 'transferred_owner' }>;
  const orderIds = orders.map((order) => String(order.id));
  const orderItems = ticketScope.orderItems as Array<{
    id: string;
    item_position: number | null;
    status: string | null;
    ownership_status: string | null;
    holder_full_name: string | null;
    shirt_type: string | null;
    shirt_size: string | null;
    participant_id: string | null;
    order_id: string | null;
    ticket_category_id: string | null;
    batch_id: string | null;
  }>;

  const participantIds = Array.from(new Set(orderItems.map((item) => item.participant_id).filter(Boolean) as string[]));
  const categoryIds = Array.from(new Set(orderItems.map((item) => item.ticket_category_id).filter(Boolean) as string[]));
  const batchIds = Array.from(new Set(orderItems.map((item) => item.batch_id).filter(Boolean) as string[]));
  const eventIds = Array.from(new Set(orders.map((order) => order.event_id).filter(Boolean) as string[]));

  const [participantsResult, categoriesResult, batchesResult, eventsResult, paymentsResult, issuesResult] = await Promise.all([
    participantIds.length > 0
      ? supabase.from('participants').select('id, full_name').in('id', participantIds)
      : Promise.resolve({ data: [], error: null }),
    categoryIds.length > 0
      ? supabase.from('ticket_categories').select('id, name').in('id', categoryIds)
      : Promise.resolve({ data: [], error: null }),
    batchIds.length > 0
      ? supabase.from('registration_batches').select('id, name').in('id', batchIds)
      : Promise.resolve({ data: [], error: null }),
    eventIds.length > 0
      ? supabase.from('events').select('id, name, starts_at, location').in('id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    orderIds.length > 0
      ? supabase
        .from('payments')
        .select('id, order_id, payment_method, payment_status, created_at')
        .in('order_id', orderIds)
        .order('created_at', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    participantIds.length > 0
      ? supabase.from('participant_data_issues').select('participant_id,blocks_ticket_issuance').in('participant_id', participantIds).eq('status', 'open').eq('blocks_ticket_issuance', true)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (participantsResult.error || categoriesResult.error || batchesResult.error || eventsResult.error || paymentsResult.error || issuesResult.error) {
    console.error('[meus-ingressos] erro ao carregar relacionamentos', {
      participants: participantsResult.error,
      categories: categoriesResult.error,
      batches: batchesResult.error,
      events: eventsResult.error,
      payments: paymentsResult.error,
      issues: issuesResult.error,
    });
    return (
      <section className="rounded-3xl border border-rose-700/40 bg-rose-950/20 p-5 text-sm text-rose-100">
        Erro ao carregar ingressos. Tente novamente em instantes.
      </section>
    );
  }

  const ordersById = new Map(orders.map((order) => [String(order.id), order]));
  const participantsById = new Map(((participantsResult.data ?? []) as Array<{ id: string; full_name: string | null }>).map((row) => [String(row.id), row]));
  const categoriesById = new Map(((categoriesResult.data ?? []) as Array<{ id: string; name: string | null }>).map((row) => [String(row.id), row]));
  const batchesById = new Map(((batchesResult.data ?? []) as Array<{ id: string; name: string | null }>).map((row) => [String(row.id), row]));
  const eventsById = new Map(((eventsResult.data ?? []) as Array<{ id: string; name: string | null; starts_at: string | null; location: string | null }>).map((row) => [String(row.id), row]));
  const ticketsByOrderItemId = new Map((ticketScope.tickets as Array<{ id: string; status: string | null; token: string | null; issued_at: string | null; used_at: string | null; order_item_id: string | null }>).map((row) => [String(row.order_item_id), row]));
  const ticketBlockedParticipantIds = new Set((issuesResult.data ?? []).map((issue) => String(issue.participant_id)));
  const paymentsByOrderId = new Map<string, { payment_method: string | null; payment_status: string | null }>();
  for (const payment of ((paymentsResult.data ?? []) as Array<{ order_id: string | null; payment_method: string | null; payment_status: string | null }>)) {
    const orderId = String(payment.order_id ?? '');
    if (!orderId || paymentsByOrderId.has(orderId)) continue;
    paymentsByOrderId.set(orderId, {
      payment_method: payment.payment_method,
      payment_status: payment.payment_status,
    });
  }

  const enhancedItems = await Promise.all(
    (orderItems ?? []).map(async (item) => {
      const order = ordersById.get(String(item.order_id ?? ''));
      const participant = participantsById.get(String(item.participant_id ?? ''));
      const eventObj = eventsById.get(String(order?.event_id ?? ''));
      const payment = paymentsByOrderId.get(String(order?.id ?? ''));
      const categoryObj = categoriesById.get(String(item.ticket_category_id ?? ''));
      const batchObj = batchesById.get(String(item.batch_id ?? ''));
      const ticket = ticketsByOrderItemId.get(String(item.id));
      const ticketIssuanceBlocked = ticketBlockedParticipantIds.has(String(item.participant_id ?? ''));
      const kitResult = ticket?.id
        ? await supabase.rpc('get_ticket_kit_items', { p_ticket_id: ticket.id })
        : { data: [] as Array<Record<string, unknown>> };

      const kitItems = (kitResult.data ?? []) as Array<Record<string, unknown>>;
      const kitDelivered = kitItems.length > 0 && kitItems.every((row) => String(row.status ?? '') === 'delivered');
      const shirtKitItem = kitItems.find((row) => String(row.item_type ?? '') === 'shirt');
      const shirtVariant = (shirtKitItem?.variant_data ?? {}) as Record<string, unknown>;
      const shirtType = optionalDisplayValue(shirtVariant.shirt_type ?? item.shirt_type);
      const shirtSize = optionalDisplayValue(shirtVariant.shirt_size ?? item.shirt_size);
      const orderStatus = normalizeStatus(String(order?.status ?? 'pending'));
      const paymentStatus = normalizeStatus(String(payment?.payment_status ?? 'pending'));
      const canShowTicket = !ticketIssuanceBlocked && Boolean(ticket?.id) && orderStatus === 'confirmed' && (ticket?.status === 'active' || ticket?.status === 'used');
      let qrUrl: string | null = null;
      if (canShowTicket && ticket?.token) {
        try {
          qrUrl = await generateQrDataUrl(String(ticket.token), 220);
        } catch {
          qrUrl = null;
        }
      }
      const holderName = participant?.full_name || item.holder_full_name || 'Titular ainda nao definido';
      const ticketStatus = normalizeStatus(String(ticket?.status ?? item.status ?? 'pending'));

      return {
        id: String(item.id),
        itemPosition: Number(item.item_position ?? 0),
        eventName: eventObj?.name ? String(eventObj.name) : 'Evento',
        date: eventObj?.starts_at ? formatDateBR(String(eventObj.starts_at)) : null,
        location: optionalDisplayValue(eventObj?.location),
        holderName,
        category: optionalDisplayValue(categoryObj?.name),
        batch: optionalDisplayValue(batchObj?.name),
        shirtType: shirtKitItem && shirtType && shirtSize ? shirtType : null,
        shirtSize: shirtKitItem && shirtType && shirtSize ? shirtSize : null,
        paymentStatus,
        kitStatus: kitItems.length > 0 ? (kitDelivered ? ('delivered' as const) : ('pending' as const)) : null,
        checkinDone: Boolean(ticket?.used_at),
        status: ticketStatus,
        qrUrl,
        canShowTicket,
        ticketIssuanceBlocked,
        ticketId: ticket?.id ? String(ticket.id) : null,
        orderId: order?.id ? String(order.id) : null,
        isBuyer: order?.buyer_type === 'account' && String(order?.user_id ?? '') === user.id,
      };
    }),
  );

  const activeTicketsCount = enhancedItems.filter((item) => item.status === 'active').length;
  const ticketsSummary = enhancedItems.length === 0
    ? null
    : enhancedItems.length === 1
      ? (activeTicketsCount === 1 ? '1 ingresso ativo' : '1 ingresso')
      : `${enhancedItems.length} ingressos${activeTicketsCount > 0 ? ` • ${activeTicketsCount} ativo${activeTicketsCount === 1 ? '' : 's'}` : ''}`;

  return (
    <section className="space-y-4">
      {headerEvent ? <MilitrinHeader event={headerEvent} /> : null}

      <section className={cx(militrinTokens.radius, militrinTokens.surface, militrinTokens.shadow, 'p-4 sm:p-5')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className={militrinType.sectionTitle}>Ingressos e QR Codes</h2>
            <p className={cx('mt-0.5', militrinType.bodyMuted)}>Acesse seus ingressos confirmados e QR Codes.</p>
          </div>
          {ticketsSummary ? <p className={cx('shrink-0', militrinType.bodyMuted)}>{ticketsSummary}</p> : null}
        </div>

        <div className="mt-4">
      {(orderItems ?? []).length === 0 ? (
        <MilitrinEmptyState
          title="Você ainda não possui ingressos."
          description="Assim que seu pagamento for confirmado, o ingresso aparece aqui automaticamente."
          actionHref="/minha-conta/comprar"
          actionLabel="Ver eventos"
        />
      ) : (
        <div className="space-y-3">
          {enhancedItems.map((item) => (
            <MilitrinTicketCard
              key={item.id}
              eventName={item.eventName}
              date={item.date}
              location={item.location}
              holderName={item.holderName}
              category={item.category}
              batch={item.batch}
              shirtType={item.shirtType}
              shirtSize={item.shirtSize}
              paymentStatus={item.paymentStatus}
              kitStatus={item.kitStatus}
              checkinDone={item.checkinDone}
              status={item.status}
              qrUrl={item.canShowTicket ? item.qrUrl : null}
              actions={(
                <>
                  {item.canShowTicket ? (
                    <MilitrinLinkButton href={`/minha-conta/ingressos/${item.ticketId}#qr`} variant="success" size="sm" iconLeft={<QrCode size={14} />} className="flex-1 sm:flex-none">
                      Abrir QR Code
                    </MilitrinLinkButton>
                  ) : null}
                  {item.ticketId ? (
                    <MilitrinLinkButton href={`/minha-conta/ingressos/${item.ticketId}`} variant="secondary" size="sm" className="flex-1 sm:flex-none">
                      Ver ingresso
                    </MilitrinLinkButton>
                  ) : null}
                  {item.orderId && item.isBuyer ? (
                    <MilitrinLinkButton href={`/minha-conta/compras/${item.orderId}`} variant="secondary" size="sm" className="flex-1 sm:flex-none">
                      Ver compra
                    </MilitrinLinkButton>
                  ) : null}
                  {!item.canShowTicket && item.paymentStatus === 'pending' && item.orderId && item.isBuyer ? (
                    <MilitrinLinkButton href={`/minha-conta/compras/${item.orderId}`} variant="warning" size="sm" className="flex-1 sm:flex-none">
                      Continuar pagamento
                    </MilitrinLinkButton>
                  ) : null}
                </>
              )}
            />
          ))}
        </div>
      )}
        </div>
      </section>
    </section>
  );
}
