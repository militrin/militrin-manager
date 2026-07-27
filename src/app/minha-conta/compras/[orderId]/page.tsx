import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { payOrderNowAction, resendTicketEmailAction } from '@/app/minha-conta/actions';
import { TicketViewer } from '@/components/public/TicketViewer';
import { PixCodeBox } from '@/components/public/PixCodeBox';
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

export default async function OrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: order, error } = await supabase
    .from('orders')
    .select('id, order_number, status, base_amount, discount_amount, final_amount, created_at, confirmed_at, participant_id, participants(id, full_name, reservation_expires_at, shirt_type, shirt_size, ticket_categories(name), registration_batches(name)), events(name, location, starts_at), payments(id, payment_method, payment_status, pix_code, expires_at, paid_at), tickets(participant_id, token, status)')
    .eq('id', orderId)
    .eq('user_id', user?.id ?? '')
    .maybeSingle();

  if (error) throw error;
  if (!order) notFound();

  const participant = Array.isArray(order.participants) ? order.participants[0] : order.participants;
  const eventObj = Array.isArray(order.events) ? order.events[0] : order.events;
  const payment = Array.isArray(order.payments) ? order.payments[0] : order.payments;
  const tickets = Array.isArray(order.tickets) ? order.tickets : (order.tickets ? [order.tickets] : []);
  const aggregate = buildLegacyOrderAggregate({
    orderId: String(order.id),
    orderNumber: String(order.order_number),
    status: String(order.status),
    baseAmount: Number(order.base_amount ?? 0),
    discountAmount: Number(order.discount_amount ?? 0),
    finalAmount: Number(order.final_amount ?? 0),
    participant,
    tickets,
  });

  const normalizedOrderStatus = normalizeStatus(String(order.status));
  const normalizedPaymentStatus = normalizeStatus(String(payment?.payment_status));
  const canShowTicket = normalizedOrderStatus === 'confirmed' && aggregate.items.some((item) => item.ticketToken);

  const { data: couponRedemption } = await supabase
    .from('coupon_redemptions')
    .select('discount_amount, coupons(code, coupon_type, discount_percent)')
    .eq('participant_id', order.participant_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const couponObj = Array.isArray(couponRedemption?.coupons) ? couponRedemption?.coupons[0] : couponRedemption?.coupons;
  const couponCode = couponObj?.code ? String(couponObj.code) : null;

  const { data: kitItemsData } = await supabase.rpc('get_participant_kit_items', {
    p_participant_id: order.participant_id,
  });

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
              <p>Categoria: {(() => {
                const category = participant?.ticket_categories;
                const categoryObj = Array.isArray(category) ? category[0] : category;
                return categoryObj?.name ? String(categoryObj.name) : '-';
              })()}</p>
              <p>Lote: {(() => {
                const batch = participant?.registration_batches;
                const batchObj = Array.isArray(batch) ? batch[0] : batch;
                return batchObj?.name ? String(batchObj.name) : '-';
              })()}</p>
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
