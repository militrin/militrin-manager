import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateTimeBR } from '@/lib/utils/date';
import { MilitrinSection, MilitrinStatusBadge } from '@/components/militrin';
import { PixCodeBox } from '@/components/public/PixCodeBox';
import { isSyntheticGatewayPayload } from '@/lib/payments/synthetic-gateway-payload';
import { getStatusLabel } from '@/lib/status-labels';
import { optionalDisplayValue } from '@/lib/optional-display';
import { StoreOrderActions } from '../store-order-actions';
import { orderDisplayReference } from '@/lib/display-reference';
import { canContinueCommercialPayment, resolveCommercialStatus, resolvePaymentDisplayStatus } from '@/lib/dashboard/commercial-status';
import { formatStoreVariantLabel } from '@/lib/operations/store-order-scan-ref';
import { accountStoreItemHref } from '@/lib/store/get-account-store-orders';
import { formatStoreQuantityLabel, pickStoreProductImageUrl, resolveStorePickupStatus } from '@/lib/store/store-pickup-pass';
import { Shirt } from 'lucide-react';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export default async function StoreOrderDetailPage({ params }: { params: Promise<{ storeOrderId: string }> }) {
  const { storeOrderId } = await params;
  if (!isUuid(storeOrderId)) notFound();

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: order, error } = await supabase
    .from('store_orders')
    .select('id, order_number, display_number, status, payment_method, payment_status, base_amount, final_amount, pix_code, pix_qrcode, expires_at, created_at, confirmed_at, cancelled_at, gateway_checkout_url, gateway_payment_id, provider, last_gateway_attempt_status, events(name), store_order_items(id, quantity, unit_price, final_amount, status, delivered_at, pickup_qr_mode, store_items(name, description, store_item_images(image_url, is_primary, sort_order)), store_item_variants(name, value))')
    .eq('id', storeOrderId)
    .eq('user_id', user?.id ?? '')
    .maybeSingle();

  if (error) {
    console.error('[minha-conta/compras/loja/[storeOrderId]] erro ao carregar pedido', { storeOrderId, error });
    return (
      <section className="rounded-2xl border border-rose-700/40 bg-rose-950/20 p-4 text-sm text-rose-100">
        Não foi possível carregar os detalhes deste pedido agora.
      </section>
    );
  }
  if (!order) notFound();

  const eventObj = one(order.events as Record<string, unknown> | Record<string, unknown>[] | null);
  const items = Array.isArray(order.store_order_items) ? order.store_order_items as Array<Record<string, unknown>> : [];
  const commercialStatus = resolveCommercialStatus({
    orderStatus: order.status,
    paymentStatus: order.payment_status,
    reservationExpiresAt: order.expires_at,
  });
  const status = commercialStatus;
  const paymentStatus = resolvePaymentDisplayStatus({
    commercialStatus,
    paymentStatus: order.payment_status,
  });
  const paymentMethod = order.payment_method === 'credit_card' ? 'credit_card' : order.payment_method === 'pix' ? 'pix' : null;
  const canContinuePayment = canContinueCommercialPayment(commercialStatus);
  const isPixPending = canContinuePayment && paymentMethod === 'pix';
  const syntheticPix = isSyntheticGatewayPayload({
    pixCode: order.pix_code,
    pixQrCode: order.pix_qrcode,
    gatewayPaymentId: order.gateway_payment_id,
    provider: order.provider,
  });
  const isCardPending = canContinuePayment && paymentMethod === 'credit_card';
  const cardRefused = String(order.last_gateway_attempt_status ?? '') === 'refused';
  const needsPaymentRetry = (isPixPending && !order.pix_code) || (isCardPending && !order.gateway_checkout_url);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <Link href="/minha-conta/loja" className="text-xs text-slate-400 underline">
          Voltar para Loja
        </Link>
        <Link href="/minha-conta/compras" className="text-xs text-slate-400 underline">
          Voltar para minhas compras
        </Link>
      </div>

      <MilitrinSection
        eyebrow="Pedido da loja"
        title={`Pedido ${orderDisplayReference(order.display_number, order.order_number)}`}
        description={(eventObj as Record<string, unknown> | null)?.name ? String((eventObj as Record<string, unknown>).name) : 'Evento'}
        action={<MilitrinStatusBadge status={status} />}
      >
        <div className="grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
          <p>Data: {formatDateTimeBR(String(order.created_at), ' às ')}</p>
          <p>Valor final: {money(Number(order.final_amount ?? 0))}</p>
          <p>Origem: {order.payment_method === 'admin_courtesy' ? 'Concedido pela organização' : optionalDisplayValue(order.payment_method)}</p>
          <p>Pagamento: {getStatusLabel(paymentStatus)}</p>
        </div>

        <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Itens do pedido</p>
          <ul className="mt-3 space-y-2">
            {items.map((item) => {
              const storeItem = one(item.store_items as Record<string, unknown> | Record<string, unknown>[] | null);
              const variant = one(item.store_item_variants as Record<string, unknown> | Record<string, unknown>[] | null);
              const images = Array.isArray((storeItem as Record<string, unknown> | null)?.store_item_images)
                ? ((storeItem as Record<string, unknown>).store_item_images as Array<Record<string, unknown>>)
                : [];
              const imageUrl = pickStoreProductImageUrl(images);
              const itemName = (storeItem as Record<string, unknown> | null)?.name ? String((storeItem as Record<string, unknown>).name) : 'Item';
              const variantLabel = formatStoreVariantLabel(variant as { name?: string; value?: string } | null);
              const pickupStatus = resolveStorePickupStatus({
                itemStatus: String(item.status ?? ''),
                deliveredAt: item.delivered_at ? String(item.delivered_at) : null,
                pickupQrMode: item.pickup_qr_mode ? String(item.pickup_qr_mode) : null,
              });
              const pickupLabel = pickupStatus === 'delivered'
                ? 'Item retirado'
                : pickupStatus === 'pending'
                  ? 'Retirada pendente'
                  : pickupStatus === 'none'
                    ? 'Retirada pela organização'
                    : getStatusLabel(String(item.status ?? 'reserved'));
              return (
                <li key={String(item.id)}>
                  <Link href={accountStoreItemHref(String(order.id), String(item.id))} className="group flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2.5 transition hover:border-emerald-500/50">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-800 bg-slate-950">
                      {imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={imageUrl} alt="" className="h-full w-full object-contain p-1" />
                      ) : (
                        <Shirt size={18} className="text-emerald-300/80" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">{itemName}</p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {[variantLabel, formatStoreQuantityLabel(Number(item.quantity ?? 1))].filter(Boolean).join(' · ')}
                        {' · '}
                        {money(Number(item.final_amount ?? 0))}
                      </p>
                      <p className="mt-1 text-[11px] text-emerald-200/80">{pickupLabel}</p>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-emerald-300">Ver item</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        {isPixPending && order.pix_code && !syntheticPix ? (
          <div className="mt-4 space-y-3">
            <PixCodeBox code={String(order.pix_code)} />
            {order.pix_qrcode ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={String(order.pix_qrcode)} alt="QR Code PIX" className="h-44 w-44 rounded-xl border border-slate-700 bg-white p-2" />
            ) : null}
            {order.expires_at ? <p className="text-xs text-slate-400">Expira em: {formatDateTimeBR(String(order.expires_at), ' às ')}</p> : null}
          </div>
        ) : null}

        {isPixPending && !order.pix_code ? (
          <p className="mt-4 text-sm text-amber-200">O pedido foi criado, mas o PIX ainda não está disponível. Tente gerar o pagamento novamente.</p>
        ) : null}

        {isPixPending && order.pix_code && syntheticPix ? (
          <p className="mt-4 text-sm text-rose-200">Este PIX não é uma cobrança real. Cancele o pedido e tente novamente.</p>
        ) : null}

        {isCardPending ? (
          <div className="mt-4 space-y-2 text-sm text-slate-200">
            {cardRefused ? <p className="text-rose-200">Cartão recusado. Tente novamente na página segura do Asaas.</p> : <p>Pagamento com cartão pendente ou em processamento. O Militrin não armazena número nem CVV.</p>}
            {order.gateway_checkout_url ? (
              <a href={String(order.gateway_checkout_url)} className="inline-flex h-9 items-center rounded-lg bg-emerald-500 px-3 text-xs font-semibold text-emerald-950">
                {cardRefused ? 'Tentar pagamento novamente' : 'Pagar com cartão'}
              </a>
            ) : (
              <p className="text-amber-200">O pedido existe, mas a página do cartão ainda não foi gerada. Tente iniciar o pagamento novamente.</p>
            )}
          </div>
        ) : null}

        {status === 'confirmed' ? (
          <div className="mt-4 overflow-hidden rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
            <div className="p-4">
              <p className="text-sm font-semibold text-emerald-200">Pagamento confirmado</p>
              <p className="mt-1 text-xs text-emerald-100/80">
                Abra cada item para ver o comprovante e o QR de retirada. Pedidos com vários produtos não compartilham um único QR.
              </p>
            </div>
          </div>
        ) : null}

        {status === 'cancelled' ? (
          <p className="mt-4 text-sm text-rose-300">Este pedido foi cancelado.</p>
        ) : status === 'expired' ? (
          <p className="mt-4 text-sm text-amber-200">Este pedido expirou. Não é possível continuar esta cobrança.</p>
        ) : canContinuePayment && paymentMethod ? (
          <div className="mt-4">
            <StoreOrderActions storeOrderId={String(order.id)} canCancel paymentMethod={paymentMethod} needsPaymentRetry={needsPaymentRetry} />
          </div>
        ) : null}
      </MilitrinSection>
    </div>
  );
}
