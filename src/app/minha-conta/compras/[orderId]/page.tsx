import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { payOrderNowAction, resendTicketEmailAction } from '@/app/minha-conta/actions';
import { TicketViewer } from '@/components/public/TicketViewer';
import { PixCodeBox } from '@/components/public/PixCodeBox';
import { PaymentReceiptPdfButton } from '@/components/public/PaymentReceiptPdfButton';
import { buildLegacyOrderAggregate } from '@/lib/orders/aggregate';
import { formatDateTimeBR } from '@/lib/utils/date';
import { MilitrinButton, MilitrinSection, MilitrinStatusBadge } from '@/components/militrin';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function normalizeStatus(status: string | null | undefined) {
  const normalized = String(status ?? 'pending').toLowerCase();
  if (normalized === 'paid') return 'confirmed';
  return normalized;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export default async function OrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  if (!isUuid(orderId)) notFound();

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: order, error } = await supabase
    .from('orders')
    .select('id, order_number, status, base_amount, discount_amount, final_amount, created_at, confirmed_at, participant_id, event_id')
    .eq('id', orderId)
    .eq('user_id', user?.id ?? '')
    .maybeSingle();

  if (error) {
    console.error('[minha-conta/compras/[orderId]] erro ao carregar pedido', { orderId, error });
    return (
      <section className="rounded-2xl border border-rose-700/40 bg-rose-950/20 p-4 text-sm text-rose-100">
        Nao foi possivel carregar os detalhes desta compra agora.
      </section>
    );
  }
  if (!order) notFound();

  const participantId = order.participant_id ? String(order.participant_id) : null;
  const eventId = order.event_id ? String(order.event_id) : null;

  const [participantResult, eventResult, paymentResult, ticketsResult] = await Promise.all([
    participantId
      ? supabase
          .from('participants')
          .select('id, full_name, reservation_expires_at, shirt_type, shirt_size, ticket_category_id, batch_id')
          .eq('id', participantId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    eventId
      ? supabase
          .from('events')
          .select('id, name, location, starts_at')
          .eq('id', eventId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from('payments')
      .select('id, payment_method, payment_status, pix_code, expires_at, paid_at, order_id, created_at')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('tickets')
      .select('participant_id, token, status, order_id')
      .eq('order_id', orderId),
  ]);

  if (participantResult.error || eventResult.error || paymentResult.error || ticketsResult.error) {
    console.error('[minha-conta/compras/[orderId]] erro ao carregar dados relacionados', {
      orderId,
      participant: participantResult.error,
      event: eventResult.error,
      payment: paymentResult.error,
      tickets: ticketsResult.error,
    });
    return (
      <section className="rounded-2xl border border-rose-700/40 bg-rose-950/20 p-4 text-sm text-rose-100">
        Nao foi possivel carregar os detalhes desta compra agora.
      </section>
    );
  }

  const participant = participantResult.data;
  const eventObj = eventResult.data;
  const payment = paymentResult.data;

  const [categoryResult, batchResult] = await Promise.all([
    participant?.ticket_category_id
      ? supabase
          .from('ticket_categories')
          .select('id, name')
          .eq('id', String(participant.ticket_category_id))
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    participant?.batch_id
      ? supabase
          .from('registration_batches')
          .select('id, name')
          .eq('id', String(participant.batch_id))
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (categoryResult.error || batchResult.error) {
    console.error('[minha-conta/compras/[orderId]] erro ao carregar categoria/lote', {
      orderId,
      category: categoryResult.error,
      batch: batchResult.error,
    });
    return (
      <section className="rounded-2xl border border-rose-700/40 bg-rose-950/20 p-4 text-sm text-rose-100">
        Nao foi possivel carregar os detalhes desta compra agora.
      </section>
    );
  }

  const categoryObj = categoryResult.data;
  const batchObj = batchResult.data;
  const tickets = (ticketsResult.data ?? []) as Array<{ participant_id: string | null; token: string | null; status: string | null }>;

  const aggregate = buildLegacyOrderAggregate({
    orderId: String(order.id),
    orderNumber: String(order.order_number),
    status: String(order.status),
    baseAmount: Number(order.base_amount ?? 0),
    discountAmount: Number(order.discount_amount ?? 0),
    finalAmount: Number(order.final_amount ?? 0),
    participant: participant
      ? {
          ...participant,
          ticket_categories: categoryObj,
          registration_batches: batchObj,
        }
      : null,
    tickets,
  });

  const normalizedOrderStatus = normalizeStatus(String(order.status));
  const normalizedPaymentStatus = normalizeStatus(String(payment?.payment_status));
  const canShowTicket = normalizedOrderStatus === 'confirmed' && aggregate.items.some((item) => item.ticketToken);
  const receiptItemsSummary = aggregate.items
    .map((item) => `${item.participantName ?? 'Titular'}${item.categoryName ? ` • ${item.categoryName}` : ''}${item.ticketStatus ? ` • ${item.ticketStatus}` : ''}`)
    .join('; ');

  const { data: couponRedemption } = participantId
    ? await supabase
        .from('coupon_redemptions')
        .select('discount_amount, coupons(code, coupon_type, discount_percent)')
        .eq('participant_id', participantId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null };

  const couponObj = Array.isArray(couponRedemption?.coupons) ? couponRedemption?.coupons[0] : couponRedemption?.coupons;
  const couponCode = couponObj?.code ? String(couponObj.code) : null;

  const { data: kitItemsData } = participantId
    ? await supabase.rpc('get_participant_kit_items', {
        p_participant_id: participantId,
      })
    : { data: [] };

  async function resendAction() {
    'use server';
    await resendTicketEmailAction(orderId);
  }

  async function payNowAction() {
    'use server';
    await payOrderNowAction(orderId);
  }

  return (
    <section className="space-y-4">
      <MilitrinSection eyebrow="Minha compra" title="Detalhe do pedido" description={`Pedido ${String(order.order_number)}`}>
        <div className="grid gap-3 lg:grid-cols-2">
          <article className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Resumo do pedido</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <p>Numero do pedido: {String(order.order_number)}</p>
              <p>Data da compra: {formatDateTimeBR(String(order.created_at), ' as ')}</p>
              <p>Valor original: {money(Number(order.base_amount ?? 0))}</p>
              <p>Desconto: {money(Number(order.discount_amount ?? 0))}</p>
              <p>Cupom: {couponCode ?? 'Sem cupom'}</p>
              <p>Desconto cupom: {money(Number(couponRedemption?.discount_amount ?? 0))}</p>
              <p>Valor final: {money(Number(order.final_amount ?? 0))}</p>
              <p className="inline-flex items-center gap-2">Status pedido: <MilitrinStatusBadge status={normalizedOrderStatus} /></p>
            </div>
          </article>

          <article className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Participante e evento</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <p>Participante: {participant?.full_name ? String(participant.full_name) : '-'}</p>
              <p>Evento: {eventObj?.name ? String(eventObj.name) : '-'}</p>
              <p>Categoria: {categoryObj?.name ? String(categoryObj.name) : '-'}</p>
              <p>Lote: {batchObj?.name ? String(batchObj.name) : '-'}</p>
              <p>Camiseta: {participant?.shirt_type ? String(participant.shirt_type) : '-'} / {participant?.shirt_size ? String(participant.shirt_size) : '-'}</p>
              <p>Local: {eventObj?.location ? String(eventObj.location) : '-'}</p>
            </div>
          </article>
        </div>
      </MilitrinSection>

      <MilitrinSection eyebrow="Pagamento" title="Pagamento e prazos" description="Acompanhe status e reserva da inscricao.">
        <div className="grid gap-3 lg:grid-cols-2">
          <article className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
            <div className="grid gap-2 sm:grid-cols-2">
              <p>Forma de pagamento: {payment?.payment_method ? String(payment.payment_method) : '-'}</p>
              <p className="inline-flex items-center gap-2">Status pagamento: <MilitrinStatusBadge status={normalizedPaymentStatus} /></p>
              <p>Status pedido: {normalizedOrderStatus}</p>
              <p>Pago em: {payment?.paid_at ? formatDateTimeBR(String(payment.paid_at), ' as ') : '-'}</p>
            </div>

            {normalizedOrderStatus === 'pending' && participant?.reservation_expires_at ? (
              <p className="mt-3 rounded-xl border border-amber-700/40 bg-amber-950/20 p-3 text-sm text-amber-100">
                Prazo da reserva: {formatDateTimeBR(String(participant.reservation_expires_at), ' as ')}
              </p>
            ) : null}

            {normalizedPaymentStatus === 'pending' && payment?.payment_method === 'pix' && payment?.pix_code ? (
              <div className="mt-3">
                <PixCodeBox code={String(payment.pix_code)} />
              </div>
            ) : null}
          </article>

          {Array.isArray(kitItemsData) && kitItemsData.length > 0 ? (
            <article className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Kit</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {kitItemsData.map((item: Record<string, unknown>) => (
                  <li key={String(item.kit_item_id)}>
                    {String(item.item_name)} x{Number(item.quantity ?? 1)} - {String(item.status ?? 'reserved')}
                  </li>
                ))}
              </ul>
            </article>
          ) : null}
        </div>
      </MilitrinSection>

      <MilitrinSection eyebrow="Ingresso" title="Ticket e QR Code" description="Disponivel apenas para pedidos confirmados.">
        {canShowTicket ? (
          <div className="space-y-4">
            {aggregate.items.filter((item) => item.ticketToken).map((item, index) => (
              <div key={item.id} className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
                <p className="mb-3 text-sm text-slate-300">Ingresso {index + 1}</p>
                <TicketViewer
                  eventName={String(eventObj?.name ?? 'Evento')}
                  participantName={item.participantName ?? String(participant?.full_name ?? '')}
                  status={item.ticketStatus ?? 'active'}
                  categoryName={item.categoryName}
                  eventDate={eventObj?.starts_at ? formatDateTimeBR(String(eventObj.starts_at), ' as ') : null}
                  eventLocation={eventObj?.location ? String(eventObj.location) : null}
                  token={String(item.ticketToken)}
                  orderNumber={String(order.order_number)}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-300">QR Code e PDF ficam disponiveis somente para compra confirmada.</p>
        )}
      </MilitrinSection>

      <div className="flex flex-wrap gap-2">
        <PaymentReceiptPdfButton
          orderNumber={String(order.order_number)}
          eventName={String(eventObj?.name ?? 'Evento')}
          createdAt={order.created_at ? formatDateTimeBR(String(order.created_at), ' as ') : null}
          paymentStatus={normalizedPaymentStatus}
          paymentMethod={String(payment?.payment_method ?? '-')}
          finalAmount={money(Number(order.final_amount ?? 0))}
          itemsSummary={receiptItemsSummary}
          className="rounded-2xl border border-slate-600 px-4 py-2 text-sm text-slate-100"
        />
        {normalizedPaymentStatus === 'pending' ? (
          <form action={payNowAction}>
            <MilitrinButton type="submit">Continuar pagamento</MilitrinButton>
          </form>
        ) : null}
        {canShowTicket ? (
          <form action={resendAction}>
            <MilitrinButton type="submit" variant="success">Reenviar ingresso por e-mail</MilitrinButton>
          </form>
        ) : null}
        <Link href="/minha-conta/compras">
          <MilitrinButton variant="secondary">Voltar para compras</MilitrinButton>
        </Link>
      </div>
    </section>
  );
}
