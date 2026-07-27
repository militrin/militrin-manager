import Link from 'next/link';
import Image from 'next/image';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR } from '@/lib/utils/date';

function makeQrUrl(token: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(token)}`;
}

export default async function IngressosPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: tickets, error } = await supabase
    .from('tickets')
    .select('id, token, status, issued_at, orders!inner(user_id, order_number, events(name, starts_at, location), participants(full_name, shirt_type, shirt_size, ticket_categories(name), registration_batches(name)))')
    .in('status', ['active', 'used'])
    .eq('orders.user_id', user?.id ?? '')
    .order('issued_at', { ascending: false });

  if (error) {
    return <section className="rounded-[2rem] border border-rose-700/40 bg-rose-950/20 p-5 text-sm text-rose-100">Erro ao carregar ingressos: {error.message}</section>;
  }

  return (
    <section className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-6 shadow-lg shadow-black/10">
      <p className="text-xs uppercase tracking-[0.22em] text-emerald-300">Meus ingressos</p>
      <h2 className="mt-2 text-3xl font-semibold text-white">Ingressos ativos e usados</h2>
      <p className="mt-2 text-sm text-slate-300">Aqui aparecem apenas os ingressos que pertencem à sua conta.</p>

      <div className="mt-6 space-y-3">
        {(tickets ?? []).length === 0 ? (
          <p className="text-sm text-slate-300">Você ainda não possui ingressos.</p>
        ) : (
          (tickets ?? []).map((ticket) => {
            const order = Array.isArray(ticket.orders) ? ticket.orders[0] : ticket.orders;
            const eventObj = Array.isArray(order?.events) ? order.events[0] : order?.events;
            const participant = Array.isArray(order?.participants) ? order.participants[0] : order?.participants;
            const categoryObj = Array.isArray(participant?.ticket_categories) ? participant.ticket_categories[0] : participant?.ticket_categories;
            const batchObj = Array.isArray(participant?.registration_batches) ? participant.registration_batches[0] : participant?.registration_batches;
            const qrUrl = makeQrUrl(String(ticket.token));

            return (
              <article key={ticket.id} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-[220px] flex-1">
                    <p className="text-lg font-semibold text-white">{eventObj?.name ? String(eventObj.name) : 'Evento'}</p>
                    <p className="text-sm text-slate-300">Participante: {participant?.full_name ? String(participant.full_name) : '-'}</p>
                    <p className="text-sm text-slate-400">Categoria: {categoryObj?.name ? String(categoryObj.name) : '-'}</p>
                    <p className="text-sm text-slate-400">Lote: {batchObj?.name ? String(batchObj.name) : '-'}</p>
                    <p className="text-sm text-slate-400">Camiseta: {participant?.shirt_type ? String(participant.shirt_type) : '-'} / {participant?.shirt_size ? String(participant.shirt_size) : '-'}</p>
                    <p className="text-sm text-slate-400">Data: {eventObj?.starts_at ? formatDateBR(String(eventObj.starts_at)) : '-'}</p>
                    <p className="text-sm text-slate-400">Local: {eventObj?.location ? String(eventObj.location) : '-'}</p>
                  </div>
                  <div className="flex flex-col items-end gap-3">
                    <span className="rounded-full border border-emerald-500/40 px-3 py-1 text-xs uppercase tracking-wide text-emerald-200">{ticket.status}</span>
                    <div className="rounded-xl border border-slate-700 bg-white p-2">
                      <Image src={qrUrl} alt="QR Code do ingresso" width={132} height={132} unoptimized className="h-[132px] w-[132px]" />
                    </div>
                    <Link href={`/minha-conta/ingressos/${ticket.id}`} className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-emerald-950">
                      Ver ingresso completo
                    </Link>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}