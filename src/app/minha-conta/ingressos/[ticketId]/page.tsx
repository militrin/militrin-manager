import { notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';
import { TicketViewer } from '@/components/public/TicketViewer';

export default async function TicketDetailPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: ticket, error } = await supabase
    .from('tickets')
    .select('id, token, status, issued_at, orders!inner(user_id, order_number, events(name, starts_at, location), participants(full_name, ticket_categories(name)))')
    .eq('id', ticketId)
    .eq('orders.user_id', user?.id ?? '')
    .maybeSingle();

  if (error) throw error;
  if (!ticket) notFound();

  const order = Array.isArray(ticket.orders) ? ticket.orders[0] : ticket.orders;
  const eventObj = Array.isArray(order?.events) ? order.events[0] : order?.events;
  const participant = Array.isArray(order?.participants) ? order.participants[0] : order?.participants;
  const categoryObj = Array.isArray(participant?.ticket_categories) ? participant.ticket_categories[0] : participant?.ticket_categories;

  return (
    <section className="space-y-4 rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-6 shadow-lg shadow-black/10">
      <p className="text-xs uppercase tracking-[0.22em] text-emerald-300">Meu ingresso</p>
      <h2 className="text-3xl font-semibold text-white">QR Code do ingresso</h2>

      <div className="grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
        <p>Evento: {eventObj?.name ? String(eventObj.name) : '-'}</p>
        <p>Participante: {participant?.full_name ? String(participant.full_name) : '-'}</p>
        <p>Status: {String(ticket.status)}</p>
        <p>Categoria: {categoryObj?.name ? String(categoryObj.name) : '-'}</p>
        <p>Data: {eventObj?.starts_at ? formatDateBR(String(eventObj.starts_at)) : '-'}</p>
        <p>Local: {eventObj?.location ? String(eventObj.location) : '-'}</p>
      </div>

      <TicketViewer
        eventName={String(eventObj?.name ?? 'Evento')}
        participantName={String(participant?.full_name ?? '')}
        status={String(ticket.status)}
        categoryName={categoryObj?.name ? String(categoryObj.name) : null}
        eventDate={eventObj?.starts_at ? formatDateBR(String(eventObj.starts_at)) : null}
        eventLocation={eventObj?.location ? String(eventObj.location) : null}
        token={String(ticket.token)}
      />
    </section>
  );
}