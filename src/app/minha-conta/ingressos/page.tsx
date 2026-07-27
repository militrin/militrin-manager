import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';
import { MilitrinButton, MilitrinEmptyState, MilitrinSection, MilitrinTicketCard } from '@/components/militrin';

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

  const { data: tickets, error } = await supabase
    .from('tickets')
    .select('id, status, token, issued_at, participant_id, participants(full_name, shirt_type, shirt_size, ticket_categories(name), registration_batches(name)), orders(id, order_number, status, events(name, starts_at, location), payments(payment_method, payment_status))')
    .eq('orders.user_id', user?.id ?? '')
    .order('issued_at', { ascending: false });

  if (error) {
    return (
      <section className="rounded-3xl border border-rose-700/40 bg-rose-950/20 p-5 text-sm text-rose-100">
        Erro ao carregar ingressos. Tente novamente em instantes.
      </section>
    );
  }

  return (
    <MilitrinSection
      eyebrow="Meus ingressos"
      title="Tickets e QR Codes"
      description="Acesse rapidamente seus ingressos confirmados e veja o status de cada um."
    >
      {(tickets ?? []).length === 0 ? (
        <MilitrinEmptyState
          title="Nenhum ingresso encontrado"
          description="Quando seu pagamento for confirmado, o ingresso aparecera aqui automaticamente."
          actionHref="/minha-conta/comprar"
          actionLabel="Comprar ingresso"
        />
      ) : (
        <div className="space-y-3">
          {(tickets ?? []).map((ticket) => {
            const order = Array.isArray(ticket.orders) ? ticket.orders[0] : ticket.orders;
            const participant = Array.isArray(ticket.participants) ? ticket.participants[0] : ticket.participants;
            const eventObj = Array.isArray(order?.events) ? order?.events?.[0] : order?.events;
            const payment = Array.isArray(order?.payments) ? order?.payments[0] : order?.payments;
            const categoryObj = Array.isArray(participant?.ticket_categories) ? participant?.ticket_categories[0] : participant?.ticket_categories;
            const batchObj = Array.isArray(participant?.registration_batches) ? participant?.registration_batches[0] : participant?.registration_batches;

            const orderStatus = normalizeStatus(String(order?.status ?? 'pending'));
            const paymentStatus = normalizeStatus(String(payment?.payment_status ?? 'pending'));
            const canShowTicket = orderStatus === 'confirmed' && (ticket.status === 'active' || ticket.status === 'used');
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(String(ticket.token ?? '-'))}`;

            return (
              <MilitrinTicketCard
                key={ticket.id}
                eventName={eventObj?.name ? String(eventObj.name) : 'Evento'}
                date={eventObj?.starts_at ? formatDateBR(String(eventObj.starts_at)) : '-'}
                location={eventObj?.location ? String(eventObj.location) : '-'}
                category={categoryObj?.name ? String(categoryObj.name) : '-'}
                batch={batchObj?.name ? String(batchObj.name) : '-'}
                shirt={`${String(participant?.shirt_type ?? '-')}/${String(participant?.shirt_size ?? '-')}`}
                status={normalizeStatus(String(ticket.status ?? 'pending'))}
                qrUrl={qrUrl}
                actions={(
                  <>
                    <Link href={`/minha-conta/compras/${order?.id}`}>
                      <MilitrinButton size="sm" variant="secondary">Ver compra</MilitrinButton>
                    </Link>
                    {canShowTicket ? (
                      <Link href={`/minha-conta/ingressos/${ticket.id}`}>
                        <MilitrinButton size="sm" variant="success">Ver QR Code</MilitrinButton>
                      </Link>
                    ) : null}
                    {!canShowTicket && paymentStatus === 'pending' && order?.id ? (
                      <Link href={`/minha-conta/compras/${order.id}`}>
                        <MilitrinButton size="sm" variant="warning">Continuar pagamento</MilitrinButton>
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
