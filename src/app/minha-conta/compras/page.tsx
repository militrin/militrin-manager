import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR, formatDateTimeBR } from '@/lib/utils/date';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
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
        Erro ao carregar compras: {error.message}
      </section>
    );
  }

  return (
    <section className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
      <h2 className="text-lg font-semibold">Suas compras</h2>
      <div className="mt-4 space-y-3">
        {(orders ?? []).length === 0 ? (
          <p className="text-sm text-slate-300">Voce ainda nao possui compras.</p>
        ) : (
          (orders ?? []).map((order) => {
            const participant = Array.isArray(order.participants) ? order.participants[0] : order.participants;
            const eventObj = Array.isArray(order.events) ? order.events[0] : order.events;
            const payment = Array.isArray(order.payments) ? order.payments[0] : order.payments;
            const category = participant?.ticket_categories;
            const categoryObj = Array.isArray(category) ? category[0] : category;
            const ticket = Array.isArray(order.tickets) ? order.tickets[0] : order.tickets;

            return (
              <article key={order.id} className="rounded-2xl border border-slate-700 bg-slate-950/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-slate-300">Pedido {order.order_number}</p>
                    <p className="text-lg font-semibold">{eventObj?.name ? String(eventObj.name) : 'Evento'}</p>
                  </div>
                  <span className="rounded-full border border-slate-600 px-3 py-1 text-xs uppercase tracking-wide text-slate-200">{order.status}</span>
                </div>

                <div className="mt-3 grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
                  <p>Data: {formatDateBR(String(order.created_at))}</p>
                  <p>Participante: {participant?.full_name ? String(participant.full_name) : '-'}</p>
                  <p>Categoria: {categoryObj?.name ? String(categoryObj.name) : '-'}</p>
                  <p>Valor: {money(Number(order.final_amount ?? 0))}</p>
                  <p>Pagamento: {payment?.payment_method ? String(payment.payment_method) : '-'}</p>
                  <p>Status pagamento: {payment?.payment_status ? String(payment.payment_status) : '-'}</p>
                </div>

                {order.status === 'pending' && participant?.reservation_expires_at ? (
                  <p className="mt-2 text-xs text-amber-200">Reserva ate {formatDateTimeBR(String(participant.reservation_expires_at), ' as ')}</p>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                  <Link href={`/minha-conta/compras/${order.id}`} className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-emerald-950">
                    Ver compra
                  </Link>
                  {ticket?.status === 'active' || ticket?.status === 'used' ? (
                    <Link href={`/minha-conta/ingressos/${ticket.id}`} className="rounded-xl border border-emerald-500/40 px-3 py-2 text-xs text-emerald-200">
                      Ver QR Code
                    </Link>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}
