import Link from 'next/link';
import { notFound } from 'next/navigation';
import { StorePickupPass } from '@/components/store/StorePickupPass';
import { StorePickupPassActions } from '@/components/store/StorePickupPassActions';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { hasPermission } from '@/lib/admin/permissions';
import { generateQrDataUrl } from '@/lib/qr/generate-qr-data-url';
import {
  buildStorePickupPassData,
  pickStoreProductImageUrl,
  type StorePickupPassData,
} from '@/lib/store/store-pickup-pass';

function one(value: unknown) {
  return (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function withQr(pass: StorePickupPassData) {
  if (!pass.canShowQr || !pass.qrPayload) return { pass, qrDataUrl: null as string | null };
  try {
    return { pass, qrDataUrl: await generateQrDataUrl(pass.qrPayload, 320) };
  } catch {
    return { pass, qrDataUrl: null as string | null };
  }
}

export default async function AccountStoreItemPage({ params }: { params: Promise<{ storeOrderId: string; itemId: string }> }) {
  const { storeOrderId, itemId } = await params;
  if (!isUuid(storeOrderId) || !isUuid(itemId)) notFound();

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data: item, error } = await supabase
    .from('store_order_items')
    .select('id,quantity,status,created_at,delivered_at,qr_token,pickup_qr_mode,store_items(name,description,store_item_images(image_url,is_primary,sort_order)),store_item_variants(name,value),store_orders!inner(id,user_id,order_number,display_number,status,payment_status,payment_method,created_at,events(name))')
    .eq('id', itemId)
    .eq('store_order_id', storeOrderId)
    .maybeSingle();
  if (error || !item) notFound();

  const order = one(item.store_orders);
  if (order?.user_id !== user.id) {
    const [canDeliver, canManage] = await Promise.all([hasPermission('store.deliver'), hasPermission('store.manage')]);
    if (!canDeliver && !canManage) notFound();
  }

  const product = one(item.store_items);
  const variant = one(item.store_item_variants);
  const event = one(order?.events);
  const images = Array.isArray(product?.store_item_images) ? (product?.store_item_images as Array<Record<string, unknown>>) : [];
  const pickupQrMode = item.pickup_qr_mode === 'per_unit' || item.pickup_qr_mode === 'none' ? item.pickup_qr_mode : 'per_line';
  const quantity = Number(item.quantity ?? 1);
  const productImageUrl = pickStoreProductImageUrl(images);
  const baseInput = {
    productName: String(product?.name ?? 'Item'),
    productImageUrl,
    variant: variant as { name?: string; value?: string } | null,
    quantity,
    displayNumber: order?.display_number,
    orderNumber: order?.order_number ? String(order.order_number) : null,
    orderCreatedAt: order?.created_at ? String(order.created_at) : String(item.created_at),
    itemStatus: String(item.status ?? ''),
    paymentStatus: String(order?.payment_status ?? order?.status ?? item.status ?? ''),
    deliveredAt: item.delivered_at ? String(item.delivered_at) : null,
    pickupQrMode,
    itemQrToken: item.qr_token ? String(item.qr_token) : null,
    eventName: event?.name ? String(event.name) : null,
  };

  let passes: StorePickupPassData[] = [];
  if (pickupQrMode === 'per_unit' && quantity > 1) {
    const { data: units } = await supabase
      .from('store_order_item_pickup_units')
      .select('id, unit_index, qr_token, status, delivered_at')
      .eq('store_order_item_id', itemId)
      .order('unit_index', { ascending: true });
    passes = (units ?? []).map((unit) =>
      buildStorePickupPassData({
        ...baseInput,
        unitQrToken: unit.qr_token ? String(unit.qr_token) : null,
        unitLabel: `Unidade ${unit.unit_index} de ${quantity}`,
        itemStatus: String(unit.status ?? item.status ?? ''),
        deliveredAt: unit.delivered_at ? String(unit.delivered_at) : null,
      }),
    );
  } else {
    passes = [buildStorePickupPassData(baseInput)];
  }

  const rendered = await Promise.all(passes.map(withQr));

  return (
    <div className="mx-auto w-full max-w-[420px] space-y-4 pb-28">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-300/80">Item da loja</p>
          <Link href={`/minha-conta/compras/loja/${storeOrderId}`} className="text-xs text-slate-400 underline">
            Voltar para o pedido
          </Link>
        </div>
        <Link
          href={`/minha-conta/compras/loja/${storeOrderId}`}
          aria-label="Fechar"
          className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-700 text-slate-300 hover:border-slate-500"
        >
          ×
        </Link>
      </div>

      {rendered.map(({ pass, qrDataUrl }, index) => (
        <div key={pass.unitLabel ?? index} className="space-y-4">
          <StorePickupPass pass={pass} qrDataUrl={qrDataUrl} />
          <StorePickupPassActions pass={pass} className="pt-1" />
        </div>
      ))}
    </div>
  );
}
