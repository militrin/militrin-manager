import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { formatDateTimeBR } from '@/lib/utils/date';
import { MilitrinSection, MilitrinStatusBadge } from '@/components/militrin';
import { PixCodeBox } from '@/components/public/PixCodeBox';
import { getStatusLabel } from '@/lib/status-labels';
import { optionalDisplayValue } from '@/lib/optional-display';
import { StoreOrderActions } from '../store-order-actions';
import { StoreOrderReceiptButtons } from '@/components/store/StoreOrderReceiptButtons';
import { orderDisplayReference } from '@/lib/display-reference';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function normalizeStatus(status: string | null | undefined) {
  const normalized = String(status ?? 'pending').toLowerCase();
  if (normalized === 'paid') return 'confirmed';
  return normalized;
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
    .select('id, order_number, display_number, status, payment_method, payment_status, base_amount, final_amount, pix_code, pix_qrcode, expires_at, created_at, confirmed_at, cancelled_at, events(name), store_order_items(id, quantity, unit_price, final_amount, status, delivered_at, store_items(name, description), store_item_variants(name, value))')
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
  const status = normalizeStatus(order.status);
  const paymentStatus = normalizeStatus(order.payment_status);
  const isPixPending = status === 'pending' && order.payment_method === 'pix' && order.pix_code;

  return (
    <div className="space-y-4">
      <Link href="/minha-conta/compras" className="text-xs text-slate-400 underline">
        Voltar para minhas compras
      </Link>

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
          <ul className="mt-2 space-y-2 text-sm text-slate-200">
            {items.map((item) => {
              const storeItem = one(item.store_items as Record<string, unknown> | Record<string, unknown>[] | null);
              const variant = one(item.store_item_variants as Record<string, unknown> | Record<string, unknown>[] | null);
              return (
                <li key={String(item.id)}>
                  <Link href={`/minha-conta/compras/loja/${order.id}/itens/${item.id}`} className="group block rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2 transition hover:border-emerald-500/50">
                  <p>
                    {String(item.quantity)}x {(storeItem as Record<string, unknown> | null)?.name ? String((storeItem as Record<string, unknown>).name) : 'Item'}
                    {variant ? ` — ${(variant as Record<string, unknown>).name}: ${(variant as Record<string, unknown>).value}` : ''}
                    {' — '}{money(Number(item.final_amount ?? 0))}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">Status: {getStatusLabel(String(item.status ?? 'reserved'))}</p>
                  <p className="mt-2 text-xs font-semibold text-emerald-300">Ver item e QR Code</p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        {isPixPending ? (
          <div className="mt-4 space-y-3">
            <PixCodeBox code={String(order.pix_code)} />
            {order.pix_qrcode ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={String(order.pix_qrcode)} alt="QR Code PIX" className="h-44 w-44 rounded-xl border border-slate-700 bg-white p-2" />
            ) : null}
            {order.expires_at ? <p className="text-xs text-slate-400">Expira em: {formatDateTimeBR(String(order.expires_at), ' às ')}</p> : null}
          </div>
        ) : null}

        {status === 'confirmed' ? (
          <div className="mt-4 overflow-hidden rounded-2xl border border-emerald-500/30 bg-emerald-500/10">
            <div className="p-4">
              <p className="text-sm font-semibold text-emerald-200">Pagamento confirmado</p>
              <p className="mt-1 text-xs text-emerald-100/80">Mostre este comprovante na retirada dos itens no evento.</p>
            </div>
            <div className="flex flex-col gap-4 border-t border-emerald-500/20 p-4 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="text-xs uppercase tracking-[0.2em] text-emerald-300/70">Itens a retirar</p>
                <p className="mt-1 text-xs text-emerald-100/80">Abra cada item para apresentar seu QR Code individual.</p>
                <ul className="mt-2 space-y-1.5 text-sm text-emerald-50">
                  {items.map((item) => {
                    const storeItem = one(item.store_items as Record<string, unknown> | Record<string, unknown>[] | null);
                    const variant = one(item.store_item_variants as Record<string, unknown> | Record<string, unknown>[] | null);
                    const itemName = (storeItem as Record<string, unknown> | null)?.name ? String((storeItem as Record<string, unknown>).name) : 'Item';
                    const variantText = variant ? ` — ${(variant as Record<string, unknown>).name}: ${(variant as Record<string, unknown>).value}` : '';
                    return (
                      <li key={String(item.id)} className="flex items-baseline gap-1.5">
                        <span className="font-semibold">{String(item.quantity)}x</span>
                        <span>{itemName}{variantText}</span>
                      </li>
                    );
                  })}
                </ul>
                <StoreOrderReceiptButtons
                  className="mt-3"
                  storeOrderId={String(order.id)}
                  orderNumber={orderDisplayReference(order.display_number, order.order_number)}
                  eventName={(eventObj as Record<string, unknown> | null)?.name ? String((eventObj as Record<string, unknown>).name) : null}
                  items={items.map((item) => {
                    const storeItem = one(item.store_items as Record<string, unknown> | Record<string, unknown>[] | null);
                    const variant = one(item.store_item_variants as Record<string, unknown> | Record<string, unknown>[] | null);
                    return {
                      quantity: Number(item.quantity ?? 1),
                      name: (storeItem as Record<string, unknown> | null)?.name ? String((storeItem as Record<string, unknown>).name) : 'Item',
                      variantText: variant ? `${(variant as Record<string, unknown>).name}: ${(variant as Record<string, unknown>).value}` : null,
                    };
                  })}
                />
              </div>
            </div>
          </div>
        ) : null}

        {status === 'cancelled' ? (
          <p className="mt-4 text-sm text-rose-300">Este pedido foi cancelado.</p>
        ) : status === 'pending' ? (
          <div className="mt-4">
            <StoreOrderActions storeOrderId={String(order.id)} canCancel />
          </div>
        ) : null}
      </MilitrinSection>
    </div>
  );
}
