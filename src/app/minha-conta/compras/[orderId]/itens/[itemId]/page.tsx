import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ProductQrViewer } from '@/components/public/ProductQrViewer';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createServiceRoleSupabaseClient } from '@/lib/supabase/admin';
import { hasPermission } from '@/lib/admin/permissions';
import { orderDisplayReference } from '@/lib/display-reference';

function one(value: unknown) {
  return (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// Item de produto "compre junto" (order_items.item_kind='product', dentro
// do pedido de ingresso) -- espelha byte a byte a pagina irma de loja
// standalone (.../compras/loja/[storeOrderId]/itens/[itemId]), so trocando
// o dominio (orders/order_items em vez de store_orders/store_order_items).
// Le com service role pelo mesmo motivo ja documentado na rota de API de QR
// deste dominio: RLS de orders/order_items nao cobre store.deliver/
// store.manage, entao a autorizacao real e o `if` explicito abaixo.
export default async function AccountOrderItemPage({ params }: { params: Promise<{ orderId: string; itemId: string }> }) {
  const { orderId, itemId } = await params;
  if (!isUuid(orderId) || !isUuid(itemId)) notFound();

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const adminClient = createServiceRoleSupabaseClient();
  const { data: item, error } = await adminClient
    .from('order_items')
    .select('id,quantity,status,created_at,delivered_at,qr_token,pickup_qr_mode,item_kind,store_items(name,description),store_item_variants(name,value),orders!inner(id,user_id,order_number,display_number,events(name))')
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
  const variant = one(item.store_item_variants);
  const event = one(order?.events);
  const itemName = String(product?.name ?? 'Item');
  const variantText = variant ? `${variant.name}: ${variant.value}` : null;
  const origin = `Pedido ${orderDisplayReference(order?.display_number as string | number | null, order?.order_number as string | null)}`;
  const pickupQrMode = item.pickup_qr_mode === 'per_unit' || item.pickup_qr_mode === 'none' ? item.pickup_qr_mode : 'per_line';
  const quantity = Number(item.quantity ?? 1);

  let qrCodes: Array<{ unitLabel: string | null; qrImageSrc: string; alt: string }> = [];
  // So mostra QR quando o item ja esta confirmado (pago) ou entregue --
  // nunca para 'reserved' (ainda no carrinho/pagamento pendente). Mesmo
  // racional ja usado pela secao de ingresso desta mesma tela
  // (canShowTicket): nunca exibir QR de um item ainda nao pago, mesmo que a
  // RPC de entrega ja bloqueasse a entrega em si -- aqui e so visibilidade.
  const qrEligibleStatuses = ['confirmed', 'delivered'];
  if (pickupQrMode !== 'none' && qrEligibleStatuses.includes(String(item.status))) {
    if (pickupQrMode === 'per_unit') {
      const { data: units } = await adminClient
        .from('order_item_pickup_units')
        .select('id, unit_index')
        .eq('order_item_id', itemId)
        .order('unit_index', { ascending: true });
      qrCodes = (units ?? []).map((unit) => ({
        unitLabel: `Unidade ${unit.unit_index} de ${quantity}`,
        qrImageSrc: `/api/inscricao/pedidos/${orderId}/itens/${itemId}/qrcode/unidades/${unit.id}?inline=1`,
        alt: `QR Code de retirada da unidade ${unit.unit_index} de ${itemName}`,
      }));
    } else if (item.qr_token) {
      qrCodes = [{
        unitLabel: null,
        qrImageSrc: `/api/inscricao/pedidos/${orderId}/itens/${itemId}/qrcode?inline=1`,
        alt: `QR Code de retirada de ${itemName}`,
      }];
    }
  }

  return <div className="space-y-4">
    <Link href={`/minha-conta/compras/${orderId}`} className="text-xs text-slate-400 underline">Voltar para o pedido</Link>
    <ProductQrViewer
      itemName={itemName}
      variantText={variantText}
      eventName={String(event?.name ?? 'Evento')}
      origin={origin}
      createdAt={String(item.created_at)}
      status={String(item.status)}
      deliveredAt={item.delivered_at ? String(item.delivered_at) : null}
      qrCodes={qrCodes}
    />
  </div>;
}
