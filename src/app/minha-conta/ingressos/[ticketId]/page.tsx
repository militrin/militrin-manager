import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateTimeBR } from '@/lib/utils/date';
import { MilitrinButton, MilitrinSection, MilitrinStatusBadge } from '@/components/militrin';
import { TicketViewer } from '@/components/public/TicketViewer';

function normalizeStatus(status: string | null | undefined) {
  const normalized = String(status ?? 'pending').toLowerCase();
  if (normalized === 'paid') return 'confirmed';
  return normalized;
}

export default async function TicketDetailPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: ticket, error } = await supabase
    .from('tickets')
    .select('id, token, status, issued_at, participant_id, participants(full_name, ticket_categories(name)), orders(id, order_number, status, created_at, events(name, location, starts_at), payments(payment_method, payment_status, paid_at))')
    .eq('id', ticketId)
    .eq('orders.user_id', user?.id ?? '')
    .maybeSingle();

  if (error) throw error;
  if (!ticket) notFound();

  const participant = Array.isArray(ticket.participants) ? ticket.participants[0] : ticket.participants;
  const order = Array.isArray(ticket.orders) ? ticket.orders[0] : ticket.orders;
  const eventObj = Array.isArray(order?.events) ? order?.events[0] : order?.events;
  const payment = Array.isArray(order?.payments) ? order?.payments[0] : order?.payments;

  const orderStatus = normalizeStatus(String(order?.status ?? 'pending'));
  const paymentStatus = normalizeStatus(String(payment?.payment_status ?? 'pending'));
  const ticketStatus = normalizeStatus(String(ticket.status ?? 'pending'));
  const canShowTicket = orderStatus === 'confirmed' && (ticketStatus === 'active' || ticketStatus === 'used');

  const categoryObj = Array.isArray(participant?.ticket_categories) ? participant?.ticket_categories[0] : participant?.ticket_categories;

  return (
    <section className="space-y-4">
      <MilitrinSection
        eyebrow="Ingresso"
        title="Detalhe do ticket"
        description={`Pedido ${String(order?.order_number ?? '-')}`}
      >
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
          <div className="grid gap-2 sm:grid-cols-2">
            <p>Participante: {participant?.full_name ? String(participant.full_name) : '-'}</p>
            <p>Evento: {eventObj?.name ? String(eventObj.name) : '-'}</p>
            <p>Categoria: {categoryObj?.name ? String(categoryObj.name) : '-'}</p>
            <p>Emissao: {ticket.issued_at ? formatDateTimeBR(String(ticket.issued_at), ' as ') : '-'}</p>
            <p className="inline-flex items-center gap-2">Status ticket: <MilitrinStatusBadge status={ticketStatus} /></p>
            <p className="inline-flex items-center gap-2">Status pedido: <MilitrinStatusBadge status={orderStatus} /></p>
            <p className="inline-flex items-center gap-2">Status pagamento: <MilitrinStatusBadge status={paymentStatus} /></p>
            <p>Pedido: {order?.order_number ? String(order.order_number) : '-'}</p>
          </div>
        </div>
      </MilitrinSection>

      <MilitrinSection
        eyebrow="QR Code"
        title="Acesso ao ingresso"
        description="Disponivel apenas quando o pedido estiver confirmado."
      >
        {canShowTicket ? (
          <TicketViewer
            eventName={eventObj?.name ? String(eventObj.name) : 'Evento'}
            participantName={participant?.full_name ? String(participant.full_name) : ''}
            status={ticketStatus}
            categoryName={categoryObj?.name ? String(categoryObj.name) : null}
            eventDate={eventObj?.starts_at ? formatDateTimeBR(String(eventObj.starts_at), ' as ') : null}
            eventLocation={eventObj?.location ? String(eventObj.location) : null}
            token={String(ticket.token ?? '')}
            orderNumber={order?.order_number ? String(order.order_number) : null}
            showPdfButton
          />
        ) : (
          <div className="rounded-2xl border border-amber-700/40 bg-amber-950/20 p-4 text-sm text-amber-100">
            O QR Code e o PDF ficam disponiveis apenas para compras confirmadas.
          </div>
        )}
      </MilitrinSection>

      <div className="flex flex-wrap gap-2">
        <Link href="/minha-conta/ingressos">
          <MilitrinButton variant="secondary">Voltar para ingressos</MilitrinButton>
        </Link>
        {order?.id ? (
          <Link href={`/minha-conta/compras/${order.id}`}>
            <MilitrinButton>Ver compra</MilitrinButton>
          </Link>
        ) : null}
      </div>
    </section>
  );
}
