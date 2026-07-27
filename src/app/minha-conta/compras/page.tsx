import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR, formatDateTimeBR } from '@/lib/utils/date';
import { MilitrinButton, MilitrinEmptyState, MilitrinPurchaseCard, MilitrinSection } from '@/components/militrin';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function normalizeOrderStatus(status: string) {
  const s = status.toLowerCase();
  if (s === 'paid') return 'confirmed';
  return s;
}

export default async function MinhasComprasPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, order_number, status, base_amount, discount_amount, final_amount, created_at, confirmed_at, participants(full_name, reservation_expires_at, ticket_categories(name)), events(name), payments(payment_method, payment_status), tickets(id, token, status)')
    .eq('user_id', user?.id ?? '')
    .order('created_at', { ascending: false });

  if (error) {
    return (
      <section className="rounded-3xl border border-rose-700/40 bg-rose-950/20 p-5 text-sm text-rose-100">
        Erro ao carregar compras. Tente novamente em instantes.
      </section>
    );
  }

  return (
    <MilitrinSection
      eyebrow="Minhas compras"
      title="Pedidos e pagamentos"
      description="Acompanhe valor final, status e acesso rapido aos ingressos confirmados."
    >
      {(orders ?? []).length === 0 ? (
        <MilitrinEmptyState
          title="Nenhuma compra encontrada"
          description="Assim que voce criar um pedido, ele aparecera aqui com status e detalhes."
          actionHref="/minha-conta/comprar"
          actionLabel="Comprar ingresso"
        />
      ) : (
        <div className="space-y-3">
          {(orders ?? []).map((order) => {
            const participant = Array.isArray(order.participants) ? order.participants[0] : order.participants;
            const eventObj = Array.isArray(order.events) ? order.events[0] : order.events;
            const payment = Array.isArray(order.payments) ? order.payments[0] : order.payments;
            const tickets = Array.isArray(order.tickets) ? order.tickets : (order.tickets ? [order.tickets] : []);
            const ticket = tickets[0] ?? null;
            const normalizedOrderStatus = normalizeOrderStatus(String(order.status ?? 'pending'));
            const normalizedPaymentStatus = normalizeOrderStatus(String(payment?.payment_status ?? 'pending'));
            const showQr = normalizedOrderStatus === 'confirmed' && (ticket?.status === 'active' || ticket?.status === 'used');

            return (
              <MilitrinPurchaseCard
                key={order.id}
                orderNumber={String(order.order_number)}
                eventName={eventObj?.name ? String(eventObj.name) : 'Evento'}
                date={formatDateBR(String(order.created_at))}
                finalAmount={money(Number(order.final_amount ?? 0))}
                paymentMethod={payment?.payment_method ? String(payment.payment_method) : '-'}
                paymentStatus={normalizedPaymentStatus}
                orderStatus={normalizedOrderStatus}
                expiration={
                  normalizedOrderStatus === 'pending' && participant?.reservation_expires_at
                    ? formatDateTimeBR(String(participant.reservation_expires_at), ' as ')
                    : null
                }
                actions={(
                  <>
                    <Link href={`/minha-conta/compras/${order.id}`}>
                      <MilitrinButton size="sm">Ver detalhes</MilitrinButton>
                    </Link>
                    {normalizedPaymentStatus === 'pending' ? (
                      <Link href={`/minha-conta/compras/${order.id}`}>
                        <MilitrinButton size="sm" variant="warning">Continuar pagamento</MilitrinButton>
                      </Link>
                    ) : null}
                    {showQr ? (
                      <Link href={`/minha-conta/ingressos/${ticket?.id}`}>
                        <MilitrinButton size="sm" variant="success">Ver QR Code</MilitrinButton>
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
