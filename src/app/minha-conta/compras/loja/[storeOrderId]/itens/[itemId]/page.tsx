import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MilitrinSection, MilitrinStatusBadge } from '@/components/militrin';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getStatusLabel } from '@/lib/status-labels';
import { formatDateTimeBR } from '@/lib/utils/date';
import { orderDisplayReference } from '@/lib/display-reference';

function one(value: unknown) {
  return (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export default async function AccountStoreItemPage({ params }: { params: Promise<{ storeOrderId: string; itemId: string }> }) {
  const { storeOrderId, itemId } = await params;
  if (!isUuid(storeOrderId) || !isUuid(itemId)) notFound();

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) notFound();

  const { data: item, error } = await supabase
    .from('store_order_items')
    .select('id,quantity,status,created_at,delivered_at,qr_token,store_items(name,description),store_item_variants(name,value),store_orders!inner(id,user_id,order_number,display_number,status,payment_method,created_at,events(name))')
    .eq('id', itemId)
    .eq('store_order_id', storeOrderId)
    .eq('store_orders.user_id', user.id)
    .maybeSingle();
  if (error || !item) notFound();

  const product = one(item.store_items);
  const variant = one(item.store_item_variants);
  const order = one(item.store_orders);
  const event = one(order?.events);
  const granted = order?.payment_method === 'admin_courtesy';
  const itemName = String(product?.name ?? 'Item');

  return <div className="space-y-4">
    <Link href={`/minha-conta/compras/loja/${storeOrderId}`} className="text-xs text-slate-400 underline">Voltar para o pedido</Link>
    <MilitrinSection eyebrow="Item da compra" title={itemName} description={variant ? `${variant.name}: ${variant.value}` : String(event?.name ?? 'Evento')} action={<MilitrinStatusBadge status={String(item.status)} />}>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-slate-500">Produto</dt><dd>{itemName}</dd></div>
        <div><dt className="text-xs text-slate-500">Variante</dt><dd>{variant ? `${variant.name}: ${variant.value}` : 'Sem variante'}</dd></div>
        <div><dt className="text-xs text-slate-500">Evento</dt><dd>{String(event?.name ?? 'Produto global')}</dd></div>
        <div><dt className="text-xs text-slate-500">Origem</dt><dd>{granted ? 'Concedido pela organização' : `Pedido ${orderDisplayReference(order?.display_number, order?.order_number)}`}</dd></div>
        <div><dt className="text-xs text-slate-500">Data</dt><dd>{formatDateTimeBR(String(item.created_at), ' às ')}</dd></div>
        <div><dt className="text-xs text-slate-500">Status</dt><dd>{getStatusLabel(String(item.status))}</dd></div>
      </dl>
      {item.qr_token && item.status !== 'cancelled' ? <div className="mt-5 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center">
        <p className="text-sm font-semibold text-emerald-100">QR Code individual para retirada</p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/api/loja/pedidos/${storeOrderId}/itens/${itemId}/qrcode?inline=1`} alt={`QR Code de retirada de ${itemName}`} className="mx-auto mt-3 w-full max-w-sm rounded-xl bg-white" />
        <p className="mt-2 text-xs text-emerald-100/70">Este código identifica somente este item.</p>
      </div> : null}
      <div className="mt-5 border-t border-slate-800 pt-4">
        <p className="text-xs uppercase text-slate-500">Histórico</p>
        <p className="mt-2 text-sm">{granted ? 'Item concedido pela organização' : 'Item incluído no pedido'} em {formatDateTimeBR(String(item.created_at), ' às ')}.</p>
        {item.delivered_at ? <p className="mt-1 text-sm">Entregue em {formatDateTimeBR(String(item.delivered_at), ' às ')}.</p> : null}
      </div>
    </MilitrinSection>
  </div>;
}
