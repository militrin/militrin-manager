import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { resendTicketEmailAction } from '@/app/minha-conta/actions';
import { generatePublicOrderPixAction } from '@/app/inscricao/actions';
import { TicketViewer } from '@/components/public/TicketViewer';
import { PixCodeBox } from '@/components/public/PixCodeBox';
import { PaymentReceiptPdfButton } from '@/components/public/PaymentReceiptPdfButton';
import { formatDateTimeBR } from '@/lib/utils/date';
import { MilitrinButton, MilitrinSection, MilitrinStatusBadge } from '@/components/militrin';
import { getStatusLabel } from '@/lib/status-labels';
import { optionalDisplayValue } from '@/lib/optional-display';
import { shirtDisplayLabel } from '@/lib/constants/shirts';
import { isOrderStillEditable } from '@/lib/orders/order-editability';
import { orderDisplayReference, ticketDisplayReference } from '@/lib/display-reference';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// Shape de get_cart_order_details -- a mesma fonte canonica que o CartStep
// (etapa Carrinho do checkout) usa. Ler direto daqui (em vez de agregar
// orders/participants/tickets/ticket_categories/registration_batches/
// order_item_discounts como a versao anterior desta pagina fazia) elimina o
// calculo paralelo: cada ingresso/produto ja chega com preco, desconto,
// titular e config individuais prontos.
type CartOrderItem = {
  order_item_id: string;
  item_kind: 'ticket' | 'product';
  status: string;
  quantity: number;
  item_position: number | null;
  unit_price: number;
  discount_amount: number;
  final_amount: number;
  category_name: string | null;
  batch_name: string | null;
  shirt_type: string | null;
  shirt_size: string | null;
  holder_full_name: string | null;
  participant_name: string | null;
  ticket_id: string | null;
  ticket_status: string | null;
  ticket_token: string | null;
  store_item_name: string | null;
  store_item_image_url: string | null;
  variant_name: string | null;
  variant_value: string | null;
};

type CartOrderPayment = {
  amount: number;
  discount_amount: number;
  final_amount: number;
  payment_method: string | null;
  payment_status: string;
  pix_code: string | null;
  expires_at: string | null;
  paid_at: string | null;
} | null;

type CartOrderDetails = {
  order_id: string;
  order_number: string | null;
  order_status: string;
  event_id: string;
  event_name: string | null;
  base_amount: number;
  discount_amount: number;
  final_amount: number;
  applied_coupon_code: string | null;
  payment: CartOrderPayment;
  items: CartOrderItem[];
};

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ cannotEdit?: string }>;
}) {
  const { orderId } = await params;
  const { cannotEdit } = await searchParams;
  if (!isUuid(orderId)) notFound();

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // get_cart_order_details ja exige orders.user_id = auth.uid() (ou acesso
  // de organizacao) -- nunca confiamos no orderId da URL sozinho. Erro aqui
  // (pedido inexistente OU sem acesso) trata-se igual: 404, nunca vaza qual
  // dos dois foi.
  const { data: rawOrder, error } = await supabase.rpc('get_cart_order_details', { p_order_id: orderId });
  if (error || !rawOrder) {
    if (error) console.error('[minha-conta/compras/[orderId]] erro ao carregar pedido via get_cart_order_details', { orderId, error });
    notFound();
  }

  const order = rawOrder as unknown as CartOrderDetails;
  const items = Array.isArray(order.items) ? order.items : [];
  const ticketItems = [...items]
    .filter((item) => item.item_kind === 'ticket')
    .sort((a, b) => (a.item_position ?? 0) - (b.item_position ?? 0));
  const productItems = items.filter((item) => item.item_kind === 'product');

  const [{ data: eventRow }, { data: orderCreatedRow }] = await Promise.all([
    supabase.from('events').select('id, name, slug, location, starts_at').eq('id', order.event_id).maybeSingle(),
    supabase.from('orders').select('created_at,display_number,order_number').eq('id', orderId).eq('user_id', user?.id ?? '').maybeSingle(),
  ]);

  const editable = isOrderStillEditable({
    orderStatus: order.order_status,
    paymentStatus: order.payment?.payment_status,
    paymentExpiresAt: order.payment?.expires_at,
  });
  const editHref = eventRow?.slug ? `/inscricao/${eventRow.slug}?editOrder=${orderId}` : null;

  const normalizedPaymentStatus = order.payment?.payment_status ?? 'pending';
  const canShowTicket = order.order_status === 'confirmed' && ticketItems.some((item) => item.ticket_token);
  const orderReference = orderDisplayReference(orderCreatedRow?.display_number, orderCreatedRow?.order_number ?? order.order_number);

  const receiptItemsSummary = [
    ...ticketItems.map((item) => `${item.participant_name ?? item.holder_full_name ?? 'Titular'}${item.category_name ? ` • ${item.category_name}` : ''}${item.ticket_status ? ` • ${getStatusLabel(item.ticket_status)}` : ''}`),
    ...productItems.map((item) => `${item.quantity}x ${item.store_item_name ?? 'Produto'}${item.variant_name ? ` (${item.variant_name} ${item.variant_value})` : ''}`),
  ].join('; ');

  // Kit items alem de camiseta (ja mostrada por ingresso acima) -- so faz
  // sentido consultar por ticket ja emitido.
  const ticketIds = ticketItems.map((item) => item.ticket_id).filter((id): id is string => Boolean(id));
  const kitResults = ticketIds.length > 0
    ? await Promise.all(ticketIds.map((ticketId) => supabase.rpc('get_ticket_kit_items', { p_ticket_id: ticketId })))
    : [];
  const kitItemsData = kitResults
    .flatMap((result) => result.data ?? [])
    .filter((item: Record<string, unknown>) => String(item.item_type ?? '') !== 'shirt');

  async function resendAction() {
    'use server';
    await resendTicketEmailAction(orderId);
  }

  // Gera (ou, se o total mudou desde a ultima geracao, REGENERA -- a RPC
  // apply_cart_coupon ja invalida pix_code/pix_qrcode nesse caso) o PIX pelo
  // mesmo caminho canonico do checkout publico. Nunca cria um mecanismo de
  // pagamento paralelo pra esta pagina.
  async function continuePaymentAction() {
    'use server';
    await generatePublicOrderPixAction(orderId);
  }

  return (
    <section className="space-y-4">
      <MilitrinSection eyebrow="Minha compra" title="Detalhe do pedido" description={`Pedido ${orderReference}`}>
        {cannotEdit ? (
          <div className="mb-4 rounded-2xl border border-amber-600/40 bg-amber-950/20 p-3 text-sm text-amber-100">
            Este pedido não pode mais ser alterado.
          </div>
        ) : null}
        <div className="grid gap-3 lg:grid-cols-2">
          <article className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Resumo do pedido</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <p>Número do pedido: {orderReference}</p>
              {orderCreatedRow?.created_at ? <p>Data da compra: {formatDateTimeBR(String(orderCreatedRow.created_at), ' as ')}</p> : null}
              <p>Evento: {optionalDisplayValue(eventRow?.name ?? order.event_name)}</p>
              <p>Valor original: {money(order.base_amount)}</p>
              <p>Desconto: {money(order.discount_amount)}</p>
              <p>Cupom: {order.applied_coupon_code ?? 'Sem cupom'}</p>
              <p>Valor final: {money(order.final_amount)}</p>
              <p className="inline-flex items-center gap-2">Pedido: <MilitrinStatusBadge status={order.order_status} /></p>
              <p className="inline-flex items-center gap-2">Pagamento: <MilitrinStatusBadge status={normalizedPaymentStatus} /></p>
            </div>
          </article>

          {optionalDisplayValue(eventRow?.location) || eventRow?.starts_at ? (
            <article className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Evento</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {optionalDisplayValue(eventRow?.location) ? <p>Local: {optionalDisplayValue(eventRow?.location)}</p> : null}
                {eventRow?.starts_at ? <p>Data: {formatDateTimeBR(String(eventRow.starts_at), ' as ')}</p> : null}
              </div>
            </article>
          ) : null}
        </div>
      </MilitrinSection>

      {ticketItems.length > 0 ? (
        <MilitrinSection eyebrow="Ingressos" title="Ingressos do pedido" description="Cada ingresso do pedido, com sua própria configuração — nunca consolidado.">
          <div className="space-y-3">
            {ticketItems.map((item, index) => {
              const shirtLabel = shirtDisplayLabel(item.shirt_type);
              const holderLabel = item.participant_name || item.holder_full_name;
              const position = item.item_position ?? index + 1;
              const friendlyCode = ticketDisplayReference(orderCreatedRow?.display_number, position, order.order_number);
              return (
                <article key={item.order_item_id} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-[220px] flex-1 space-y-1">
                      <p className="text-base font-semibold text-white">
                        Ingresso {position}{item.category_name ? ` — ${item.category_name}` : ''}
                      </p>
                      <p className="text-sm text-slate-300">{holderLabel ? `Titular: ${holderLabel}` : 'Titular ainda não definido'}</p>
                      {shirtLabel ? (
                        <p className="text-sm text-slate-400">{shirtLabel}{item.shirt_size ? ` · ${item.shirt_size}` : ''}</p>
                      ) : null}
                      {item.batch_name ? <p className="text-sm text-slate-400">{item.batch_name}</p> : null}
                      <p className="text-xs text-slate-500">Código: {friendlyCode}</p>
                    </div>
                    <div className="flex flex-col items-end gap-2 text-right">
                      <MilitrinStatusBadge status={item.ticket_status ?? item.status} />
                      <div>
                        <p className="text-base font-semibold text-slate-100">{money(item.unit_price)}</p>
                        {item.discount_amount > 0 ? (
                          <>
                            <p className="text-xs text-emerald-300">Desconto: -{money(item.discount_amount)}</p>
                            <p className="text-sm font-semibold text-emerald-200">Total: {money(item.final_amount)}</p>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </MilitrinSection>
      ) : null}

      {productItems.length > 0 ? (
        <MilitrinSection eyebrow="Compre junto" title="Produtos do pedido" description="Itens da loja comprados junto com o ingresso.">
          <ul className="space-y-2">
            {productItems.map((item) => {
              const lineSubtotal = item.unit_price * item.quantity;
              return (
                <li key={item.order_item_id} className="flex gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
                  {item.store_item_image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.store_item_image_url} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />
                  ) : (
                    <div className="h-14 w-14 shrink-0 rounded-lg bg-slate-800" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-slate-100">{item.store_item_name}{item.variant_name ? ` · ${item.variant_name} ${item.variant_value}` : ''}</p>
                    <p>{item.quantity}x {money(item.unit_price)}</p>
                    <p className="font-semibold">Subtotal: {money(lineSubtotal)}</p>
                    {item.discount_amount > 0 ? (
                      <>
                        <p className="text-emerald-300">Desconto: -{money(item.discount_amount)}</p>
                        <p>Total da linha: {money(item.final_amount)}</p>
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </MilitrinSection>
      ) : null}

      <MilitrinSection eyebrow="Pagamento" title="Pagamento e prazos" description="Acompanhe o pagamento e o status do pedido.">
        <div className="grid gap-3 lg:grid-cols-2">
          <article className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
            <div className="grid gap-2 sm:grid-cols-2">
              {optionalDisplayValue(order.payment?.payment_method) ? <p>Forma de pagamento: {optionalDisplayValue(order.payment?.payment_method)}</p> : null}
              <p className="inline-flex items-center gap-2">Pagamento: <MilitrinStatusBadge status={normalizedPaymentStatus} /></p>
              <p>Pedido: {getStatusLabel(order.order_status)}</p>
              {order.payment?.paid_at ? <p>Pago em: {formatDateTimeBR(String(order.payment.paid_at), ' as ')}</p> : null}
            </div>

            {order.order_status === 'pending' && order.payment?.expires_at ? (
              <p className="mt-3 rounded-xl border border-amber-700/40 bg-amber-950/20 p-3 text-sm text-amber-100">
                Prazo da reserva: {formatDateTimeBR(String(order.payment.expires_at), ' as ')}
              </p>
            ) : null}

            {normalizedPaymentStatus === 'pending' && order.payment?.payment_method === 'pix' ? (
              order.payment?.pix_code ? (
                <div className="mt-3">
                  <PixCodeBox code={String(order.payment.pix_code)} />
                </div>
              ) : (
                <p className="mt-3 text-sm text-amber-200">
                  Clique em &quot;Continuar pagamento&quot; para gerar um novo código PIX com o valor atualizado.
                </p>
              )
            ) : null}
          </article>

          {kitItemsData.length > 0 ? (
            <article className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-200">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Kit</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {kitItemsData.map((item: Record<string, unknown>) => (
                  <li key={String(item.kit_item_id)}>
                    {String(item.item_name)} x{Number(item.quantity ?? 1)} - {getStatusLabel(String(item.status ?? 'reserved'))}
                  </li>
                ))}
              </ul>
            </article>
          ) : null}
        </div>
      </MilitrinSection>

      <MilitrinSection eyebrow="Ingresso" title="Ingresso e QR Code" description="Disponível apenas para pedidos confirmados.">
        {canShowTicket ? (
          <div className="space-y-4">
            {ticketItems.filter((item) => item.ticket_token).map((item, index) => (
              <div key={item.order_item_id} className="rounded-2xl border border-slate-700 bg-slate-950/60 p-4">
                <p className="mb-3 text-sm text-slate-300">Ingresso {item.item_position ?? index + 1}</p>
                <TicketViewer
                  eventName={String(eventRow?.name ?? order.event_name ?? 'Evento')}
                  participantName={item.participant_name ?? item.holder_full_name ?? ''}
                  status={item.ticket_status ?? 'active'}
                  categoryName={item.category_name}
                  eventDate={eventRow?.starts_at ? String(eventRow.starts_at) : null}
                  eventLocation={eventRow?.location ? String(eventRow.location) : null}
                  token={String(item.ticket_token)}
                  orderNumber={orderReference}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-300">QR Code e PDF ficam disponiveis somente para compra confirmada.</p>
        )}
      </MilitrinSection>

      <div className="flex flex-wrap gap-2">
        {editable && editHref ? (
          <Link href={editHref}>
            <MilitrinButton variant="warning">Editar pedido</MilitrinButton>
          </Link>
        ) : null}
        <PaymentReceiptPdfButton
          orderNumber={orderReference}
          eventName={String(eventRow?.name ?? order.event_name ?? 'Evento')}
          createdAt={orderCreatedRow?.created_at ? String(orderCreatedRow.created_at) : null}
          paymentStatus={normalizedPaymentStatus}
          paymentMethod={optionalDisplayValue(order.payment?.payment_method)}
          finalAmount={money(order.final_amount)}
          itemsSummary={receiptItemsSummary}
          className="rounded-2xl border border-slate-600 px-4 py-2 text-sm text-slate-100"
        />
        {normalizedPaymentStatus === 'pending' ? (
          <form action={continuePaymentAction}>
            <MilitrinButton type="submit">Continuar pagamento</MilitrinButton>
          </form>
        ) : null}
        {canShowTicket ? (
          <form action={resendAction}>
            <MilitrinButton type="submit" variant="success">Reenviar ingresso por e-mail</MilitrinButton>
          </form>
        ) : null}
        <Link href="/minha-conta/compras">
          <MilitrinButton variant="secondary">Voltar para compras</MilitrinButton>
        </Link>
      </div>
    </section>
  );
}
