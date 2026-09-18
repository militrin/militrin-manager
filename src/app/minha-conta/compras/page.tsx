import { ClipboardList, CreditCard, QrCode, Ticket as TicketIcon } from 'lucide-react';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateTimeBR } from '@/lib/utils/date';
import { MilitrinEmptyState, MilitrinHeader, MilitrinLinkButton, MilitrinPurchaseCard, cx, militrinTokens, militrinType } from '@/components/militrin';
import { optionalDisplayValue } from '@/lib/optional-display';
import { getAccountOrders, resolveAccountOrderStatus, accountTicketItems } from '@/lib/account/portal-orders-and-tickets';
import { resolvePixCommercialExpiresAt } from '@/lib/payments/pix-due-date';
import { getAccountStoreOrders } from '@/lib/store/get-account-store-orders';
import { getPrimaryAccountHeaderEvent } from '@/lib/account/header-event';
import { orderDisplayReference } from '@/lib/display-reference';
import { orderChargeBreakdown } from '@/lib/orders/charge-breakdown';
import { canContinueCommercialPayment, isClosedCommercialPurchase, resolveCommercialStatus, resolvePaymentDisplayStatus } from '@/lib/dashboard/commercial-status';
import { ClosedPurchasesSection } from './closed-purchases-section';
import { PurchaseKindFilter, PurchaseKindItem } from './purchase-kind-filter';
import { StorePurchaseListCard, summarizeStoreOrderItems } from '@/components/store/StorePurchaseListCard';

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

// Resumo compacto de titularidade (nao despeja titulares individuais no
// card principal -- o detalhe completo continua em "Ver detalhes"). So
// entra em jogo com 2+ ingressos; com 0 ou 1, o card mostra o titular direto.
function titularSummary(totalItems: number, definedCount: number) {
  const pending = totalItems - definedCount;
  if (pending === 0) return `${definedCount} titulares definidos`;
  if (definedCount === 0) return `${totalItems} titulares aguardando definição`;
  return `${definedCount} titular${definedCount === 1 ? '' : 'es'} definido${definedCount === 1 ? '' : 's'} • ${pending} aguardando titular`;
}

function TicketOrderCard({ order }: { order: Record<string, unknown> }) {
  const eventObj = one(order.events as Record<string, unknown> | Record<string, unknown>[] | null);
  const payment = one(order.payments as Record<string, unknown> | Record<string, unknown>[] | null);
  // item_kind e a fonte canonica: produto "compre junto" nunca conta como
  // ingresso nem participa do resumo de titularidade (mesma regra do
  // detector de Integridade e do detalhe do pedido admin).
  const allItems = Array.isArray(order.order_items) ? order.order_items as Array<Record<string, unknown>> : (order.order_items ? [order.order_items as Record<string, unknown>] : []);
  const orderItems = accountTicketItems(order);
  const productItemCount = allItems.length - orderItems.length;
  // Status comercial canonico (mesma fonte do Dashboard admin) -- nao
  // order.status cru, que pode ficar preso em "pending" quando o pagamento
  // ja expirou mas a varredura de expiracao ainda nao converteu o pedido.
  const commercialStatus = resolveAccountOrderStatus(order);
  const normalizedPaymentStatus = resolvePaymentDisplayStatus({
    commercialStatus,
    paymentStatus: (payment as Record<string, unknown> | null)?.payment_status as string | null,
  });
  const firstTicketFromItems = orderItems
    .map((item) => one(item.tickets as Record<string, unknown> | Record<string, unknown>[] | null))
    .find((itemTicket) => itemTicket?.id) ?? null;
  const tickets = Array.isArray(order.tickets) ? order.tickets : (order.tickets ? [order.tickets] : []);
  const ticket = tickets[0] ?? null;
  const activeTicket = firstTicketFromItems ?? ticket as Record<string, unknown> | null;
  const showQr = commercialStatus === 'confirmed' && (activeTicket?.status === 'active' || activeTicket?.status === 'used');

  const holderName = (item: Record<string, unknown>) => {
    const itemParticipant = one(item.participants as Record<string, unknown> | Record<string, unknown>[] | null);
    return String(item.holder_full_name ?? '').trim() || (itemParticipant as Record<string, unknown> | null)?.full_name as string | undefined || null;
  };

  let summaryLine: string;
  if (orderItems.length === 0) {
    summaryLine = productItemCount > 0 ? `${productItemCount} produto${productItemCount === 1 ? '' : 's'}` : 'Sem itens';
  } else if (orderItems.length === 1) {
    const singleHolder = holderName(orderItems[0]);
    summaryLine = `1 ingresso • Titular: ${singleHolder || 'Não definido'}`;
  } else {
    const definedCount = orderItems.filter((item) => Boolean(holderName(item))).length;
    summaryLine = `${orderItems.length} ingressos • ${titularSummary(orderItems.length, definedCount)}`;
  }
  // Preserva a compra como um todo no resumo: produto "compre junto" nao
  // conta como ingresso, mas continua visivel no card (detalhe completo em
  // "Ver detalhes", que ja lista produtos separadamente).
  if (productItemCount > 0 && orderItems.length > 0) {
    summaryLine += ` • +${productItemCount} produto${productItemCount === 1 ? '' : 's'}`;
  }

  // payments.expires_at e a fonte canonica de validade do pagamento no fluxo
  // moderno (ver start_order_payment_pix/expire_stale_order_payments) --
  // funciona tanto pra pedidos legados de 1 participante quanto pra pedidos
  // multi-item modernos, onde orders.participant_id costuma ser null.
  const showExpiration = commercialStatus === 'pending' || commercialStatus === 'expired';
  const paymentExpiresAt = resolvePixCommercialExpiresAt({
    expiresAt: (payment as Record<string, unknown> | null)?.expires_at as string | null | undefined,
    paymentCreatedAt: (payment as Record<string, unknown> | null)?.created_at as string | null | undefined,
    paymentMethod: (payment as Record<string, unknown> | null)?.payment_method as string | null | undefined,
  });
  const charge = orderChargeBreakdown({
    itemsAmount: order.final_amount,
    customerFee: (payment as Record<string, unknown> | null)?.payment_fee_customer_amount,
    chargedAmount: (payment as Record<string, unknown> | null)?.final_amount,
  });

  return (
    <MilitrinPurchaseCard
      orderNumber={orderDisplayReference(order.display_number, order.order_number)}
      status={commercialStatus}
      eventName={(eventObj as Record<string, unknown> | null)?.name ? String((eventObj as Record<string, unknown>).name) : 'Evento'}
      dateValue={(eventObj as Record<string, unknown> | null)?.starts_at as string | null}
      dateKind="event"
      location={optionalDisplayValue((eventObj as Record<string, unknown> | null)?.location as string | null)}
      summaryLine={summaryLine}
      paymentStatus={normalizedPaymentStatus}
      finalAmount={money(charge.chargedAmount)}
      paymentMethod={optionalDisplayValue((payment as Record<string, unknown> | null)?.payment_method as string | null)}
      expirationLabel={commercialStatus === 'expired' ? 'Expirou em' : 'Expira em'}
      expirationValue={showExpiration && paymentExpiresAt ? formatDateTimeBR(String(paymentExpiresAt), ' às ') : null}
      expirationTone={commercialStatus === 'expired' ? 'danger' : 'warning'}
      primaryAction={
        canContinueCommercialPayment(commercialStatus) ? (
          <MilitrinLinkButton href={`/minha-conta/compras/${order.id}`} variant="warning" size="md" iconLeft={<CreditCard size={16} />} className="w-full">
            Continuar pagamento
          </MilitrinLinkButton>
        ) : showQr ? (
          <MilitrinLinkButton href={`/minha-conta/ingressos/${activeTicket?.id}`} prefetch={false} variant="success" size="md" iconLeft={<TicketIcon size={16} />} className="w-full">
            Ver acesso
          </MilitrinLinkButton>
        ) : (
          <MilitrinLinkButton href={`/minha-conta/compras/${order.id}`} variant="secondary" size="md" iconLeft={<ClipboardList size={16} />} className="w-full">
            Ver detalhes
          </MilitrinLinkButton>
        )
      }
      secondaryAction={
        canContinueCommercialPayment(commercialStatus) ? (
          <MilitrinLinkButton href={`/minha-conta/compras/${order.id}`} variant="secondary" size="md" iconLeft={<ClipboardList size={16} />} className="w-full">
            Ver detalhes
          </MilitrinLinkButton>
        ) : showQr ? (
          <div className="flex w-full flex-col gap-2">
            <MilitrinLinkButton href={`/minha-conta/ingressos/${activeTicket?.id}#qr`} prefetch={false} variant="secondary" size="md" iconLeft={<QrCode size={16} />} className="w-full">
              Ver QR Code
            </MilitrinLinkButton>
            {productItemCount > 0 ? (
              <MilitrinLinkButton href={`/minha-conta/compras/${order.id}#produtos-do-pedido`} variant="secondary" size="md" iconLeft={<QrCode size={16} />} className="w-full">
                {`Ver produtos (${productItemCount})`}
              </MilitrinLinkButton>
            ) : null}
          </div>
        ) : productItemCount > 0 ? (
          <MilitrinLinkButton href={`/minha-conta/compras/${order.id}#produtos-do-pedido`} variant="secondary" size="md" iconLeft={<QrCode size={16} />} className="w-full">
            {`Ver produtos (${productItemCount})`}
          </MilitrinLinkButton>
        ) : null
      }
    />
  );
}

function StoreOrderCard({ order }: { order: Record<string, unknown> }) {
  const items = Array.isArray(order.store_order_items) ? order.store_order_items as Array<Record<string, unknown>> : [];
  const commercialStatus = resolveCommercialStatus({
    orderStatus: order.status as string | null,
    paymentStatus: order.payment_status as string | null,
    reservationExpiresAt: order.expires_at as string | null,
  });
  const normalizedPaymentStatus = resolvePaymentDisplayStatus({
    commercialStatus,
    paymentStatus: order.payment_status as string | null,
  });

  return (
    <StorePurchaseListCard
      orderId={String(order.id)}
      orderNumber={orderDisplayReference(order.display_number, order.order_number)}
      commercialStatus={commercialStatus}
      paymentStatus={normalizedPaymentStatus}
      createdAt={String(order.created_at)}
      items={summarizeStoreOrderItems(items)}
      canContinuePayment={canContinueCommercialPayment(commercialStatus)}
    />
  );
}

export default async function MinhasComprasPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: orders, error }, { data: storeOrders, error: storeError }, headerEvent] = await Promise.all([
    getAccountOrders(supabase, user?.id ?? ''),
    getAccountStoreOrders(supabase, user?.id ?? ''),
    getPrimaryAccountHeaderEvent(supabase),
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

  const commercialOf = (row: (typeof rows)[number]) => (
    row.kind === 'ticket'
      ? resolveAccountOrderStatus(row.order)
      : resolveCommercialStatus({
        orderStatus: row.order.status as string | null,
        paymentStatus: row.order.payment_status as string | null,
        reservationExpiresAt: row.order.expires_at as string | null,
      })
  );
  const openRows = rows.filter((row) => !isClosedCommercialPurchase(commercialOf(row)));
  const closedRows = rows.filter((row) => isClosedCommercialPurchase(commercialOf(row)));

  function renderRow(row: (typeof rows)[number]) {
    const card = row.kind === 'ticket'
      ? <TicketOrderCard key={`ticket-${row.order.id}`} order={row.order} />
      : <StoreOrderCard key={`store-${row.order.id}`} order={row.order} />;
    return (
      <PurchaseKindItem key={`${row.kind}-${row.order.id}`} kind={row.kind}>
        {card}
      </PurchaseKindItem>
    );
  }

  return (
    <section className="space-y-4">
      {headerEvent ? <MilitrinHeader event={headerEvent} showBuyButton={headerEvent.showBuyButton} buyHref={headerEvent.buyHref} /> : null}

      <section className={cx(militrinTokens.radius, militrinTokens.surface, militrinTokens.shadow, 'p-4 sm:p-5')}>
        <div>
          <h2 className={militrinType.sectionTitle}>Minhas compras</h2>
          <p className={cx('mt-0.5', militrinType.bodyMuted)}>Acompanhe seus pedidos, ingressos e itens da loja.</p>
        </div>

        <div className="mt-4">
          {rows.length === 0 ? (
            <MilitrinEmptyState
              title="Você ainda não possui compras."
              description="Assim que você criar um pedido, ele aparece aqui com status e detalhes."
              actionHref="/minha-conta/comprar"
              actionLabel="Ver eventos"
            />
          ) : (
            <PurchaseKindFilter
              ticketCount={rows.filter((row) => row.kind === 'ticket').length}
              storeCount={rows.filter((row) => row.kind === 'store').length}
            >
              {openRows.length === 0 ? (
                <p className={militrinType.bodyMuted}>Nenhuma compra ativa no momento. Pedidos pagos e pendências ainda válidas aparecem aqui.</p>
              ) : (
                <div className="space-y-3">
                  {openRows.map(renderRow)}
                </div>
              )}
              <ClosedPurchasesSection count={closedRows.length}>
                {closedRows.map(renderRow)}
              </ClosedPurchasesSection>
            </PurchaseKindFilter>
          )}
        </div>
      </section>
    </section>
  );
}
