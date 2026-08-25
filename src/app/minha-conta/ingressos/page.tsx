import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';
import { MilitrinCard, MilitrinEmptyState, MilitrinSection, MilitrinTicketCard } from '@/components/militrin';
import { getStatusLabel } from '@/lib/status-labels';
import { optionalDisplayValue } from '@/lib/optional-display';
import { getAccessibleTicketScope, getAccountOrders } from '@/lib/account/portal-orders-and-tickets';

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

  const purchasedOrdersResult = await getAccountOrders(supabase, user.id);
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
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(String(ticket?.token ?? '-'))}`;
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
        shirt: shirtKitItem && shirtType && shirtSize ? `${shirtType}/${shirtSize}` : null,
        paymentStatus,
        kitStatus: kitItems.length > 0 ? (kitDelivered ? 'Entregue' : 'Pendente') : null,
        checkinStatus: ticket?.used_at ? 'Realizado' : 'Pendente',
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

  return (
    <MilitrinSection
      eyebrow="Meus ingressos"
      title="Ingressos e QR Codes"
      description="Acesse rapidamente seus ingressos confirmados e veja o status de cada um."
    >
      {(orderItems ?? []).length === 0 ? (
        <MilitrinEmptyState
          title="Nenhum ingresso encontrado"
          description="Quando seu pagamento for confirmado, o ingresso aparecera aqui automaticamente."
          actionHref="/minha-conta/comprar"
          actionLabel="Comprar ingresso"
        />
      ) : (
        <div className="space-y-3">
          {enhancedItems.map((item, index) => {
            if (!item.ticketId) {
              return (
                <MilitrinCard key={item.id} className="p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Item #{Number(item.itemPosition ?? index + 1)}</p>
                      <h3 className="mt-1 text-lg font-semibold text-white">{item.eventName}</h3>
                      <p className="text-sm text-slate-300">Titular: {item.holderName}</p>
                    </div>
                    <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs text-amber-100">Ingresso aguardando conferência</span>
                  </div>
                  <div className="mt-3 grid gap-2 text-sm text-slate-300 sm:grid-cols-2">
                    {item.category ? <p>Categoria: {item.category}</p> : null}
                    {item.batch ? <p>Lote: {item.batch}</p> : null}
                    {item.shirt ? <p>Camiseta: {item.shirt}</p> : null}
                    <p>Pagamento: {getStatusLabel(item.paymentStatus)}</p>
                    {item.kitStatus ? <p>Status kit: {item.kitStatus}</p> : null}
                    <p>Status check-in: {item.checkinStatus}</p>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {item.orderId && item.isBuyer ? (
                      <Link
                        href={`/minha-conta/compras/${item.orderId}`}
                        className="inline-flex h-9 items-center justify-center rounded-2xl border border-slate-700 bg-slate-900/70 px-3 text-xs font-semibold text-slate-100 transition hover:border-slate-500"
                      >
                        Ver compra
                      </Link>
                    ) : null}
                    {item.paymentStatus === 'pending' && item.orderId && item.isBuyer ? (
                      <Link
                        href={`/minha-conta/compras/${item.orderId}`}
                        className="inline-flex h-9 items-center justify-center rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/20"
                      >
                        Continuar pagamento
                      </Link>
                    ) : null}
                    {item.ticketId ? (
                      <Link
                        href={`/minha-conta/ingressos/${item.ticketId}`}
                        className="inline-flex h-9 items-center justify-center rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20"
                      >
                        Ver detalhes
                      </Link>
                    ) : null}
                  </div>
                </MilitrinCard>
              );
            }

            return (
              <MilitrinTicketCard
                key={item.ticketId}
                eventName={item.eventName}
                date={item.date}
                location={item.location}
                holderName={item.holderName}
                category={item.category}
                batch={item.batch}
                shirt={item.shirt}
                paymentStatus={item.paymentStatus}
                kitStatus={item.kitStatus}
                checkinStatus={item.checkinStatus}
                status={item.status}
                qrUrl={item.canShowTicket ? item.qrUrl : null}
                actions={(
                  <>
                    {item.orderId && item.isBuyer ? (
                      <Link
                        href={`/minha-conta/compras/${item.orderId}`}
                        className="inline-flex h-9 items-center justify-center rounded-2xl border border-slate-700 bg-slate-900/70 px-3 text-xs font-semibold text-slate-100 transition hover:border-slate-500"
                      >
                        Ver compra
                      </Link>
                    ) : null}
                    {item.canShowTicket ? (
                      <Link
                        href={`/minha-conta/ingressos/${item.ticketId}`}
                        className="inline-flex h-9 items-center justify-center rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-500/20"
                      >
                        Ver detalhes
                      </Link>
                    ) : null}
                    {!item.canShowTicket && item.paymentStatus === 'pending' && item.orderId && item.isBuyer ? (
                      <Link
                        href={`/minha-conta/compras/${item.orderId}`}
                        className="inline-flex h-9 items-center justify-center rounded-2xl border border-amber-500/40 bg-amber-500/10 px-3 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/20"
                      >
                        Continuar pagamento
                      </Link>
                    ) : null}
                  </>
                )}
              />
            );
          })}
        </div>
      )}
    </MilitrinSection>
  );
}
