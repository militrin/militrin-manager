import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { payOrderNowAction, resendTicketEmailAction } from '@/app/minha-conta/actions';
import { TicketViewer } from '@/components/public/TicketViewer';
import { PixCodeBox } from '@/components/public/PixCodeBox';
import { buildLegacyOrderAggregate } from '@/lib/orders/aggregate';
import { formatDateTimeBR } from '@/lib/utils/date';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
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
    <section className="space-y-4 rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
      <h2 className="text-lg font-semibold">Detalhe da compra</h2>

      <div className="grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
        <p>Evento: {eventObj?.name ? String(eventObj.name) : '-'}</p>
        <p>Participante: {participant?.full_name ? String(participant.full_name) : '-'}</p>
        <p>Numero do pedido: {String(order.order_number)}</p>
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
        <p>Valor original: {money(Number(order.base_amount ?? 0))}</p>
        <p>Desconto: {money(Number(order.discount_amount ?? 0))}</p>
        <p>Cupom usado: {couponCode ?? 'Sem cupom'}</p>
        <p>Desconto via cupom: {money(Number(couponRedemption?.discount_amount ?? 0))}</p>
        <p>Valor final: {money(Number(order.final_amount ?? 0))}</p>
        <p>Forma de pagamento: {payment?.payment_method ? String(payment.payment_method) : '-'}</p>
        <p>Status pagamento: {payment?.payment_status ? String(payment.payment_status) : '-'}</p>
        <p>Status pedido: {String(order.status)}</p>
        <p>Data da compra: {formatDateTimeBR(String(order.created_at), ' as ')}</p>
      </div>

      {Array.isArray(kitItemsData) && kitItemsData.length > 0 ? (
        <div className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4 text-sm text-slate-200">
          <p className="font-medium">Itens do kit</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {kitItemsData.map((item: Record<string, unknown>) => (
              <li key={String(item.kit_item_id)}>
                {String(item.item_name)} x{Number(item.quantity ?? 1)} - {String(item.status ?? 'reserved')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {order.status === 'pending' && participant?.reservation_expires_at ? (
        <p className="rounded-xl border border-amber-700/40 bg-amber-950/20 p-3 text-sm text-amber-100">
          Prazo da reserva: {formatDateTimeBR(String(participant.reservation_expires_at), ' as ')}
        </p>
      ) : null}

      {payment?.payment_status === 'pending' && payment?.payment_method === 'pix' && payment?.pix_code ? (
        <PixCodeBox code={String(payment.pix_code)} />
      ) : null}

      {String(order.status) === 'confirmed' && aggregate.items.some((item) => item.ticketToken) ? (
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
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-300">QR Code disponivel somente para compras confirmadas.</p>
      )}

      <div className="flex flex-wrap gap-2">
        {String(payment?.payment_status ?? 'pending') !== 'paid' ? (
          <form action={payNowAction}>
            <button type="submit" className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-emerald-950">Pagar agora</button>
          </form>
        ) : null}
        <form action={resendAction}>
          <button type="submit" className="rounded-xl border border-emerald-500/40 px-3 py-2 text-xs text-emerald-200">Reenviar ingresso por e-mail</button>
        </form>
        <Link href="/minha-conta/compras" className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">
          Voltar para Suas compras
        </Link>
      </div>
    </section>
  );
}
