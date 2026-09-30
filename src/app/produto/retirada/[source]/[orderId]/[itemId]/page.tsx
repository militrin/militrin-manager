import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ProductPickupPass } from '@/components/product-pickup/ProductPickupPass';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createServiceRoleSupabaseClient } from '@/lib/supabase/admin';
import { hasPermission } from '@/lib/admin/permissions';
import { generateQrDataUrl } from '@/lib/qr/generate-qr-data-url';
import {
  buildProductPickupPassData,
  formatOperationalQrPreview,
  PRODUCT_PICKUP_PASS_COPY,
  type ProductPickupQr,
} from '@/lib/product-pickup/product-pickup-pass';
import { additionalItemStatus } from '@/lib/operations/additional-product-items';

function one(value: unknown) {
  return (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function withQr(token: string | null, alt: string, unitLabel: string | null): Promise<ProductPickupQr> {
  const preview = formatOperationalQrPreview(token);
  if (!token) return { unitLabel, qrDataUrl: null, qrPreview: preview, alt };
  try {
    return { unitLabel, qrDataUrl: await generateQrDataUrl(token, 640), qrPreview: preview, alt };
  } catch {
    return { unitLabel, qrDataUrl: null, qrPreview: preview, alt };
  }
}

export default async function ProductPickupPage({
  params,
}: {
  params: Promise<{ source: string; orderId: string; itemId: string }>;
}) {
  const { source, orderId, itemId } = await params;
  if ((source !== 'checkout' && source !== 'loja') || !isUuid(orderId) || !isUuid(itemId)) notFound();

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/entrar?next=${encodeURIComponent(`/produto/retirada/${source}/${orderId}/${itemId}`)}`);
  }

  if (source === 'checkout') {
    const adminClient = createServiceRoleSupabaseClient();
    const { data: item, error } = await adminClient
      .from('order_items')
      .select('id,quantity,status,delivered_at,qr_token,pickup_qr_mode,item_kind,store_items(name),orders!inner(id,user_id,order_number,display_number,status)')
      .eq('id', itemId)
      .eq('order_id', orderId)
      .eq('item_kind', 'product')
      .maybeSingle();
    if (error || !item) notFound();

    const order = one(item.orders);
    if (order?.user_id !== user.id) {
      const [canDeliver, canManage] = await Promise.all([hasPermission('store.deliver'), hasPermission('store.manage')]);
      if (!canDeliver && !canManage) notFound();
    }

    const product = one(item.store_items);
    const pickupQrMode = item.pickup_qr_mode === 'per_unit' || item.pickup_qr_mode === 'none' ? item.pickup_qr_mode : 'per_line';
    const quantity = Number(item.quantity ?? 1);
    const status = additionalItemStatus({
      itemStatus: String(item.status ?? ''),
      deliveredAt: item.delivered_at ? String(item.delivered_at) : null,
      orderStatus: order?.status ? String(order.status) : null,
    });
    const qrEligible = status === 'confirmed' || status === 'delivered';
    let qrs: ProductPickupQr[] = [];
    if (pickupQrMode !== 'none' && qrEligible) {
      if (pickupQrMode === 'per_unit' && quantity > 1) {
        const { data: units } = await adminClient
          .from('order_item_pickup_units')
          .select('id, unit_index, qr_token')
          .eq('order_item_id', itemId)
          .order('unit_index', { ascending: true });
        qrs = await Promise.all((units ?? []).map((unit) => withQr(
          unit.qr_token ? String(unit.qr_token) : null,
          `QR Code de retirada da unidade ${unit.unit_index} de ${product?.name ?? 'produto'}`,
          `Unidade ${unit.unit_index} de ${quantity}`,
        )));
      } else if (item.qr_token) {
        qrs = [await withQr(String(item.qr_token), `QR Code de retirada de ${product?.name ?? 'produto'}`, null)];
      }
    }

    const pass = buildProductPickupPassData({
      productName: String(product?.name ?? 'Produto'),
      quantity,
      displayNumber: order?.display_number,
      orderNumber: order?.order_number,
      itemStatus: String(item.status ?? ''),
      deliveredAt: item.delivered_at ? String(item.delivered_at) : null,
      orderStatus: order?.status ? String(order.status) : null,
      qrs,
    });

    return (
      <main className="mx-auto flex min-h-screen w-full max-w-[430px] flex-col gap-4 px-4 py-6">
        <Link href="/minha-conta/compras" className="text-xs text-slate-400 underline underline-offset-2">Voltar</Link>
        <ProductPickupPass pass={pass} />
      </main>
    );
  }

  const { data: item, error } = await supabase
    .from('store_order_items')
    .select('id,quantity,status,delivered_at,qr_token,pickup_qr_mode,store_items(name),store_orders!inner(id,user_id,order_number,display_number,status,payment_status)')
    .eq('id', itemId)
    .eq('store_order_id', orderId)
    .maybeSingle();
  if (error || !item) notFound();

  const order = one(item.store_orders);
  if (order?.user_id !== user.id) {
    const [canDeliver, canManage] = await Promise.all([hasPermission('store.deliver'), hasPermission('store.manage')]);
    if (!canDeliver && !canManage) notFound();
  }

  const product = one(item.store_items);
  const pickupQrMode = item.pickup_qr_mode === 'per_unit' || item.pickup_qr_mode === 'none' ? item.pickup_qr_mode : 'per_line';
  const quantity = Number(item.quantity ?? 1);
  const status = additionalItemStatus({
    itemStatus: String(item.status ?? ''),
    deliveredAt: item.delivered_at ? String(item.delivered_at) : null,
    paymentStatus: order?.payment_status ? String(order.payment_status) : null,
  });
  const qrEligible = status === 'confirmed' || status === 'delivered';
  let qrs: ProductPickupQr[] = [];
  if (pickupQrMode !== 'none' && qrEligible) {
    if (pickupQrMode === 'per_unit' && quantity > 1) {
      const { data: units } = await supabase
        .from('store_order_item_pickup_units')
        .select('id, unit_index, qr_token')
        .eq('store_order_item_id', itemId)
        .order('unit_index', { ascending: true });
      qrs = await Promise.all((units ?? []).map((unit) => withQr(
        unit.qr_token ? String(unit.qr_token) : null,
        `QR Code de retirada da unidade ${unit.unit_index} de ${product?.name ?? 'produto'}`,
        `Unidade ${unit.unit_index} de ${quantity}`,
      )));
    } else if (item.qr_token) {
      qrs = [await withQr(String(item.qr_token), `QR Code de retirada de ${product?.name ?? 'produto'}`, null)];
    }
  }

  const pass = buildProductPickupPassData({
    productName: String(product?.name ?? 'Produto'),
    quantity,
    displayNumber: order?.display_number,
    orderNumber: order?.order_number,
    itemStatus: String(item.status ?? ''),
    deliveredAt: item.delivered_at ? String(item.delivered_at) : null,
    paymentStatus: order?.payment_status ? String(order.payment_status) : String(order?.status ?? ''),
    qrs,
  });

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[430px] flex-col gap-4 px-4 py-6">
      <Link href="/minha-conta/compras" className="text-xs text-slate-400 underline underline-offset-2">Voltar</Link>
      <ProductPickupPass pass={pass} />
      <p className="sr-only">{PRODUCT_PICKUP_PASS_COPY.title}</p>
    </main>
  );
}
