import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateTimeBR } from '@/lib/utils/date';
import { MilitrinButton, MilitrinEmptyState, MilitrinSection, MilitrinTimeline, type MilitrinTimelineItem } from '@/components/militrin';

function normalizeStatus(status: string | null | undefined) {
  const normalized = String(status ?? 'pending').toLowerCase();
  if (normalized === 'paid') return 'confirmed';
  return normalized;
}

export default async function HistoricoPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [ordersResult, ticketsResult] = await Promise.all([
    supabase
      .from('orders')
      .select('id, order_number, status, created_at, confirmed_at, final_amount, events(name)')
      .eq('user_id', user?.id ?? '')
      .order('created_at', { ascending: false })
      .limit(15),
    supabase
      .from('tickets')
      .select('id, status, issued_at, order_id, orders!inner(user_id, order_number, events(name))')
      .eq('orders.user_id', user?.id ?? '')
      .order('issued_at', { ascending: false })
      .limit(15),
  ]);

  const orderItems = (ordersResult.data ?? []).map((order) => {
    const createdAt = order.created_at ? new Date(String(order.created_at)).getTime() : 0;
    const eventObj = Array.isArray(order.events) ? order.events[0] : order.events;
    return {
      sortTs: createdAt,
      id: `order-${order.id}`,
      title: `Pedido ${String(order.order_number)}`,
      subtitle: eventObj?.name ? `Evento: ${String(eventObj.name)}` : 'Pedido no portal Militrin',
      date: order.created_at ? formatDateTimeBR(String(order.created_at), ' as ') : undefined,
      status: normalizeStatus(String(order.status ?? 'pending')),
    };
  });

  const ticketItems = (ticketsResult.data ?? []).map((ticket) => {
    const issuedAt = ticket.issued_at ? new Date(String(ticket.issued_at)).getTime() : 0;
    const order = Array.isArray(ticket.orders) ? ticket.orders[0] : ticket.orders;
    const eventObj = Array.isArray(order?.events) ? order?.events[0] : order?.events;

    return {
      sortTs: issuedAt,
      id: `ticket-${ticket.id}`,
      title: `Ingresso ${String(ticket.status ?? 'pending')}`,
      subtitle: eventObj?.name ? `Evento: ${String(eventObj.name)}` : 'Ingresso do participante',
      date: ticket.issued_at ? formatDateTimeBR(String(ticket.issued_at), ' as ') : undefined,
      status: normalizeStatus(String(ticket.status ?? 'pending')),
    };
  });

  const items: MilitrinTimelineItem[] = [...orderItems, ...ticketItems]
    .sort((a, b) => b.sortTs - a.sortTs)
    .slice(0, 20)
    .map((item) => ({
      id: item.id,
      title: item.title,
      subtitle: item.subtitle,
      date: item.date,
      status: item.status,
    }));

  return (
    <section className="space-y-4">
      <MilitrinSection
        eyebrow="Historico"
        title="Linha do tempo do participante"
        description="Acompanhe seus pedidos, confirmacoes e emissao de ingressos em ordem cronologica."
        action={
          <Link href="/minha-conta/compras">
            <MilitrinButton variant="secondary" size="sm">Ver compras</MilitrinButton>
          </Link>
        }
      >
        {!items.length ? (
          <MilitrinEmptyState
            title="Seu historico ainda esta vazio"
            description="Assim que houver compras ou emissao de ingressos, os eventos aparecerao nesta linha do tempo."
            actionHref="/minha-conta/comprar"
            actionLabel="Comprar ingresso"
          />
        ) : (
          <MilitrinTimeline items={items} />
        )}
      </MilitrinSection>

      <MilitrinSection eyebrow="Futuro" title="Em breve" description="Amigos e ranking retornam nas proximas etapas do portal premium.">
        <div className="grid gap-3 sm:grid-cols-2">
          <article className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Amigos</p>
            <p className="mt-2">Painel social com solicitacoes, conexoes e visibilidade personalizada.</p>
          </article>
          <article className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Ranking</p>
            <p className="mt-2">Ranking de participacao e niveis com filtros por periodo e eventos.</p>
          </article>
        </div>
      </MilitrinSection>
    </section>
  );
}
