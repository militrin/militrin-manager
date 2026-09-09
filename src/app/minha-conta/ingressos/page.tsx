import { QrCode } from 'lucide-react';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';
import { MilitrinEmptyState, MilitrinHeader, MilitrinLinkButton, MilitrinTicketCard, cx, militrinTokens, militrinType } from '@/components/militrin';
import { optionalDisplayValue } from '@/lib/optional-display';
import { getAccessibleTicketScope, getAccountOrders } from '@/lib/account/portal-orders-and-tickets';
import { generateQrDataUrl } from '@/lib/qr/generate-qr-data-url';
import { getPrimaryAccountHeaderEvent } from '@/lib/account/header-event';
import {
  chipStatusForOwnedTicketPayment,
  loadOwnedTicketsPaymentOperationalStatus,
  normalizeOwnedTicketPaymentChipStatus,
} from '@/lib/account/ticket-payment-operational-status';
import {
  classifyTicketOperationalSituation,
  partitionTicketsBySituation,
  ticketSituationBadgeStatus,
  ticketSituationLabel,
} from '@/lib/tickets/ticket-situation';
import { AccountTicketsSituationNav } from './tickets-situation-nav';

function normalizeStatus(status: string | null | undefined) {
  const normalized = String(status ?? 'pending').toLowerCase();
  if (normalized === 'paid') return 'confirmed';
  return normalized;
}

export default async function IngressosPage({
  searchParams,
}: {
  searchParams: Promise<{ ver?: string }>;
}) {
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

  const params = await searchParams;
  const showArchived = String(params.ver ?? '').trim().toLowerCase() === 'anteriores';

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
    { includeCancelled: true },
  );
  if (ticketScope.error) {
    console.error('[meus-ingressos] erro ao carregar escopo canônico de ingressos', {
      stage: ticketScope.stage,
      error: ticketScope.error,
    });
    return <section className="rounded-3xl border border-rose-700/40 bg-rose-950/20 p-5 text-sm text-rose-100">Erro ao carregar ingressos. Tente novamente em instantes.</section>;
  }

  const orders = ticketScope.orders as Array<{ id: string; order_number: string | null; status: string | null; event_id: string | null; user_id: string | null; buyer_type: 'account' | 'imported_holder' | 'transferred_owner' }>;
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

  const ownedTicketIds = (ticketScope.tickets as Array<{ id: string }>).map((ticket) => String(ticket.id)).filter(Boolean);
  const [participantsResult, categoriesResult, batchesResult, eventsResult, paymentStatusLoad, issuesResult] = await Promise.all([
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
      ? supabase.from('events').select('id, name, starts_at, ends_at, location, is_active').in('id', eventIds)
      : Promise.resolve({ data: [], error: null }),
    loadOwnedTicketsPaymentOperationalStatus(supabase, ownedTicketIds),
    participantIds.length > 0
      ? supabase.from('participant_data_issues').select('participant_id,blocks_ticket_issuance').in('participant_id', participantIds).eq('status', 'open').eq('blocks_ticket_issuance', true)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (paymentStatusLoad.error) {
    console.error('[meus-ingressos] erro ao carregar status operacional de pagamento', paymentStatusLoad.error);
  }

  if (participantsResult.error || categoriesResult.error || batchesResult.error || eventsResult.error || issuesResult.error) {
    console.error('[meus-ingressos] erro ao carregar relacionamentos', {
      participants: participantsResult.error,
      categories: categoriesResult.error,
      batches: batchesResult.error,
      events: eventsResult.error,
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
  const eventsById = new Map(((eventsResult.data ?? []) as Array<{ id: string; name: string | null; starts_at: string | null; ends_at: string | null; location: string | null; is_active: boolean | null }>).map((row) => [String(row.id), row]));
  const ticketsByOrderItemId = new Map((ticketScope.tickets as Array<{ id: string; status: string | null; token: string | null; issued_at: string | null; used_at: string | null; order_item_id: string | null; event_id: string | null }>).map((row) => [String(row.order_item_id), row]));
  const ticketBlockedParticipantIds = new Set((issuesResult.data ?? []).map((issue) => String(issue.participant_id)));

  const enhancedItems = await Promise.all(
    (orderItems ?? []).map(async (item) => {
      const order = ordersById.get(String(item.order_id ?? ''));
      const participant = participantsById.get(String(item.participant_id ?? ''));
      const ticket = ticketsByOrderItemId.get(String(item.id));
      const eventObj = eventsById.get(String(ticket?.event_id ?? order?.event_id ?? ''));
      const categoryObj = categoriesById.get(String(item.ticket_category_id ?? ''));
      const batchObj = batchesById.get(String(item.batch_id ?? ''));
      const ticketIssuanceBlocked = ticketBlockedParticipantIds.has(String(item.participant_id ?? ''));
      const situation = classifyTicketOperationalSituation({
        ticketStatus: ticket?.status,
        eventEndsAt: eventObj?.ends_at,
        eventStartsAt: eventObj?.starts_at,
        eventIsActive: eventObj?.is_active,
      });
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
      const paymentStatus = ticket?.id
        ? normalizeOwnedTicketPaymentChipStatus(chipStatusForOwnedTicketPayment(ticket.id, paymentStatusLoad))
        : 'unavailable';
      const canShowTicket = situation === 'ativos' && !ticketIssuanceBlocked && Boolean(ticket?.id) && orderStatus === 'confirmed' && (ticket?.status === 'active' || ticket?.status === 'used');
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
      const badgeStatus = situation === 'ativos' ? ticketStatus : ticketSituationBadgeStatus(situation);
      const badgeLabel = situation === 'ativos' ? undefined : ticketSituationLabel(situation);

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
        situation,
        badgeStatus,
        badgeLabel,
        qrUrl,
        canShowTicket,
        ticketIssuanceBlocked,
        ticketId: ticket?.id ? String(ticket.id) : null,
        orderId: order?.id ? String(order.id) : null,
        isBuyer: order?.buyer_type === 'account' && String(order?.user_id ?? '') === user.id,
      };
    }),
  );

  const { active, archived } = partitionTicketsBySituation(enhancedItems, (item) => item.situation);
  const visibleItems = showArchived ? archived : active;
  const ticketsSummary = showArchived
    ? (archived.length === 1 ? '1 ingresso anterior ou inativo' : `${archived.length} ingressos anteriores e inativos`)
    : (active.length === 1 ? '1 ingresso ativo' : `${active.length} ingressos ativos`);

  return (
    <section className="space-y-4">
      {headerEvent ? <MilitrinHeader event={headerEvent} /> : null}

      <section className={cx(militrinTokens.radius, militrinTokens.surface, militrinTokens.shadow, 'p-4 sm:p-5')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className={militrinType.sectionTitle}>{showArchived ? 'Anteriores e inativos' : 'Meus acessos e QR Codes'}</h2>
            <p className={cx('mt-0.5', militrinType.bodyMuted)}>
              {showArchived
                ? 'Histórico preservado: eventos encerrados, cancelados e inativos.'
                : 'Acesse seus pacotes Militrin ativos e o QR Code de retirada do kit.'}
            </p>
          </div>
          {enhancedItems.length > 0 ? <p className={cx('shrink-0', militrinType.bodyMuted)}>{ticketsSummary}</p> : null}
        </div>

        {enhancedItems.length > 0 ? (
          <div className="mt-4">
            <AccountTicketsSituationNav
              view={showArchived ? 'anteriores' : 'ativos'}
              activeCount={active.length}
              archivedCount={archived.length}
            />
          </div>
        ) : null}

        <div className="mt-4">
      {(orderItems ?? []).length === 0 ? (
        <MilitrinEmptyState
          title="Você ainda não possui acessos Militrin."
          description="Assim que seu pagamento for confirmado, o pacote aparece aqui automaticamente."
          actionHref="/minha-conta/comprar"
          actionLabel="Ver eventos"
        />
      ) : visibleItems.length === 0 ? (
        <MilitrinEmptyState
          title={showArchived ? 'Você não possui acessos anteriores ou inativos.' : 'Você não possui acessos ativos.'}
          description={
            showArchived
              ? 'Seus acessos ativos ficam na aba Acessos ativos.'
              : archived.length > 0
                ? 'Acessos de eventos encerrados, cancelados ou inativos ficam em Anteriores e inativos.'
                : 'Assim que seu pagamento for confirmado, o pacote aparece aqui automaticamente.'
          }
          actionHref={showArchived ? '/minha-conta/ingressos' : archived.length > 0 ? '/minha-conta/ingressos?ver=anteriores' : '/minha-conta/comprar'}
          actionLabel={showArchived ? 'Ver acessos ativos' : archived.length > 0 ? `Anteriores e inativos (${archived.length})` : 'Ver eventos'}
        />
      ) : (
        <div className="space-y-3">
          {visibleItems.map((item) => (
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
              status={item.badgeStatus}
              statusLabel={item.badgeLabel}
              qrUrl={item.canShowTicket ? item.qrUrl : null}
              actions={(
                <>
                  {item.canShowTicket ? (
                    <MilitrinLinkButton href={`/minha-conta/ingressos/${item.ticketId}${showArchived ? '?lista=anteriores' : ''}#qr`} variant="success" size="sm" iconLeft={<QrCode size={14} />} className="flex-1 sm:flex-none">
                      Abrir QR Code
                    </MilitrinLinkButton>
                  ) : null}
                  {item.ticketId ? (
                    <MilitrinLinkButton href={`/minha-conta/ingressos/${item.ticketId}${showArchived ? '?lista=anteriores' : ''}`} variant="secondary" size="sm" className="flex-1 sm:flex-none">
                      Ver acesso
                    </MilitrinLinkButton>
                  ) : null}
                  {item.orderId && item.isBuyer ? (
                    <MilitrinLinkButton href={`/minha-conta/compras/${item.orderId}`} variant="secondary" size="sm" className="flex-1 sm:flex-none">
                      Ver compra
                    </MilitrinLinkButton>
                  ) : null}
                  {!item.canShowTicket && item.situation === 'ativos' && item.paymentStatus === 'pending' && item.orderId && item.isBuyer ? (
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
