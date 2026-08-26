import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateBR, formatDateTimeBR } from '@/lib/utils/date';
import { MilitrinButton, MilitrinEmptyState, MilitrinPurchaseCard, MilitrinSection } from '@/components/militrin';
import { getStatusLabel } from '@/lib/status-labels';
import { optionalDisplayValue } from '@/lib/optional-display';
import { getAccountOrders, resolveAccountOrderStatus } from '@/lib/account/portal-orders-and-tickets';
import { getAccountStoreOrders } from '@/lib/store/get-account-store-orders';
import { orderDisplayReference } from '@/lib/display-reference';
import { resolveCommercialStatus } from '@/lib/dashboard/commercial-status';

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function normalizeOrderStatus(status: string) {
  const s = status.toLowerCase();
  if (s === 'paid') return 'confirmed';
  return s;
}

function TicketOrderCard({ order }: { order: Record<string, unknown> }) {
  const participant = one(order.participants as Record<string, unknown> | Record<string, unknown>[] | null);
  const eventObj = one(order.events as Record<string, unknown> | Record<string, unknown>[] | null);
  const payment = one(order.payments as Record<string, unknown> | Record<string, unknown>[] | null);
  const tickets = Array.isArray(order.tickets) ? order.tickets : (order.tickets ? [order.tickets] : []);
  const ticket = tickets[0] ?? null;
  const orderItems = Array.isArray(order.order_items) ? order.order_items as Array<Record<string, unknown>> : (order.order_items ? [order.order_items as Record<string, unknown>] : []);
  // Status comercial canonico (mesma fonte do Dashboard admin) -- nao
  // order.status cru, que pode ficar preso em "pending" quando o pagamento
  // ja expirou mas a varredura de expiracao ainda nao converteu o pedido.
  const commercialStatus = resolveAccountOrderStatus(order);
  const normalizedPaymentStatus = normalizeOrderStatus(String((payment as Record<string, unknown> | null)?.payment_status ?? 'pending'));
  const firstTicketFromItems = orderItems
    .map((item) => one(item.tickets as Record<string, unknown> | Record<string, unknown>[] | null))
    .find((itemTicket) => itemTicket?.id) ?? null;
  const activeTicket = firstTicketFromItems ?? ticket as Record<string, unknown> | null;
  const showQr = normalizedOrderStatus === 'confirmed' && (activeTicket?.status === 'active' || activeTicket?.status === 'used');
  const itemCount = orderItems.length > 0 ? orderItems.length : 1;
  const itemSummary = orderItems.length > 0
    ? orderItems
        .slice(0, 3)
        .map((item, idx) => {
          const itemParticipant = one(item.participants as Record<string, unknown> | Record<string, unknown>[] | null);
          const holder = (itemParticipant as Record<string, unknown> | null)?.full_name || item.holder_full_name || 'Titular ainda nao definido';
          const itemPosition = Number(item.item_position ?? idx + 1);
          return `#${itemPosition} ${holder} (${getStatusLabel(String(item.status ?? 'reserved'))})`;
        })
        .join(' • ')
    : (participant as Record<string, unknown> | null)?.full_name as string || 'Titular ainda nao definido';

  return (
    <MilitrinPurchaseCard
      orderNumber={orderDisplayReference(order.display_number, order.order_number)}
      status={commercialStatus}
      eventName={(eventObj as Record<string, unknown> | null)?.name ? String((eventObj as Record<string, unknown>).name) : 'Evento'}
      date={formatDateBR(String(order.created_at))}
      finalAmount={money(Number(order.final_amount ?? 0))}
      quantity={itemCount}
      subtitle={itemSummary}
      paymentMethod={optionalDisplayValue((payment as Record<string, unknown> | null)?.payment_method as string | null)}
      paymentStatus={normalizedPaymentStatus}
      orderStatus={normalizedOrderStatus}
      expiration={
        normalizedOrderStatus === 'pending' && (participant as Record<string, unknown> | null)?.reservation_expires_at
          ? formatDateTimeBR(String((participant as Record<string, unknown>).reservation_expires_at), ' as ')
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
            <Link href={`/minha-conta/ingressos/${activeTicket?.id}`}>
              <MilitrinButton size="sm" variant="success">Ver QR Code</MilitrinButton>
            </Link>
          ) : null}
        </>
      )}
    />
  );
}

function StoreOrderCard({ order }: { order: Record<string, unknown> }) {
  const eventObj = one(order.events as Record<string, unknown> | Record<string, unknown>[] | null);
  const items = Array.isArray(order.store_order_items) ? order.store_order_items as Array<Record<string, unknown>> : [];
  // store_orders ja tem status/payment_status/expires_at na propria linha
  // (sem relacao payments separada) -- mesma fonte canonica, forma mais
  // direta de chamar.
  const commercialStatus = resolveCommercialStatus({
    orderStatus: order.status as string | null,
    paymentStatus: order.payment_status as string | null,
    reservationExpiresAt: order.expires_at as string | null,
  });
  const normalizedPaymentStatus = normalizeOrderStatus(String(order.payment_status ?? 'pending'));
  const itemSummary = items
    .slice(0, 3)
    .map((item) => {
      const storeItem = one(item.store_items as Record<string, unknown> | Record<string, unknown>[] | null);
      const variant = one(item.store_item_variants as Record<string, unknown> | Record<string, unknown>[] | null);
      const variantText = variant ? ` — ${(variant as Record<string, unknown>).name}: ${(variant as Record<string, unknown>).value}` : '';
      return `${item.quantity}x ${(storeItem as Record<string, unknown> | null)?.name ?? 'Item'}${variantText}`;
    })
    .join(' • ');
  const showExpiration = commercialStatus === 'pending' || commercialStatus === 'expired';

  return (
    <MilitrinPurchaseCard
      orderNumber={orderDisplayReference(order.display_number, order.order_number)}
      status={commercialStatus}
      eventName={`Loja — ${(eventObj as Record<string, unknown> | null)?.name ? String((eventObj as Record<string, unknown>).name) : 'Evento'}`}
      date={formatDateBR(String(order.created_at))}
      finalAmount={money(Number(order.final_amount ?? 0))}
      subtitle={`${items.length} item(ns) • ${itemSummary}`}
      paymentMethod={optionalDisplayValue(order.payment_method as string | null)}
      paymentStatus={normalizedPaymentStatus}
      orderStatus={normalizedOrderStatus}
      expiration={
        normalizedOrderStatus === 'pending' && order.expires_at
          ? formatDateTimeBR(String(order.expires_at), ' as ')
          : null
      }
      actions={(
        <>
          <Link href={`/minha-conta/compras/loja/${order.id}`}>
            <MilitrinButton size="sm">Ver detalhes</MilitrinButton>
          </Link>
          {normalizedOrderStatus === 'pending' ? (
            <Link href={`/minha-conta/compras/loja/${order.id}`}>
              <MilitrinButton size="sm" variant="warning">Continuar pagamento</MilitrinButton>
            </Link>
          ) : null}
          {normalizedOrderStatus === 'confirmed' ? (
            <Link href={`/minha-conta/compras/loja/${order.id}`}>
              <MilitrinButton size="sm" variant="success">Ver QR Code</MilitrinButton>
            </Link>
          ) : null}
        </>
      )}
    />
  );
}

export default async function MinhasComprasPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: orders, error }, { data: storeOrders, error: storeError }] = await Promise.all([
    getAccountOrders(supabase, user?.id ?? ''),
    getAccountStoreOrders(supabase, user?.id ?? ''),
  ]);

  if (error) {
    console.error('[minha-conta/compras] erro ao carregar pedidos', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return (
      <section className="rounded-3xl border border-rose-700/40 bg-rose-950/20 p-5 text-sm text-rose-100">
        Erro ao carregar compras. Tente novamente em instantes.
      </section>
    );
  }
  if (storeError) console.error('[minha-conta/compras] erro ao carregar pedidos da loja', storeError);

  const rows = [
    ...(orders ?? []).map((order) => ({ kind: 'ticket' as const, order: order as Record<string, unknown>, createdAt: String(order.created_at) })),
    ...(storeOrders ?? []).map((order) => ({ kind: 'store' as const, order: order as Record<string, unknown>, createdAt: String(order.created_at) })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <MilitrinSection
      eyebrow="Minhas compras"
      title="Pedidos e pagamentos"
      description="Acompanhe valor final, status e acesso rapido aos ingressos e itens confirmados."
    >
      {rows.length === 0 ? (
        <MilitrinEmptyState
          title="Nenhuma compra encontrada"
          description="Assim que voce criar um pedido, ele aparecera aqui com status e detalhes."
          actionHref="/minha-conta/comprar"
          actionLabel="Comprar ingresso"
        />
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            row.kind === 'ticket'
              ? <TicketOrderCard key={`ticket-${row.order.id}`} order={row.order} />
              : <StoreOrderCard key={`store-${row.order.id}`} order={row.order} />
          ))}
        </div>
      )}
    </MilitrinSection>
  );
}
