import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { AdminPageHeader, AdminSection, AdminStatusBadge } from '@/components/admin';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getCurrentPermissionMap, requireAnyPermission } from '@/lib/admin/permissions';
import { OrderItemActions, OrderPaymentActions } from './order-detail-actions';
import { orderDisplayReference } from '@/lib/display-reference';

type OrderItemDetail = {
  id: string;
  store_item_id: string;
  name: string;
  image_url: string | null;
  variant_name: string | null;
  variant_value: string | null;
  quantity: number;
  unit_price: number;
  discount_type: 'percentage' | 'fixed' | null;
  discount_value: number;
  final_unit_price: number;
  final_amount: number;
  status: string;
  delivered_at: string | null;
  has_qr: boolean;
};

type HistoryEntry = {
  action: string;
  created_at: string;
  actor_name: string;
  details: Record<string, unknown> | null;
};

type OrderDetail = {
  order: {
    id: string;
    order_number: string;
    status: string;
    payment_method: string | null;
    payment_status: string;
    base_amount: number;
    final_amount: number;
    discount_amount: number;
    pix_code: string | null;
    pix_qrcode: string | null;
    gateway_payment_id: string | null;
    expires_at: string | null;
    paid_at: string | null;
    confirmed_at: string | null;
    cancelled_at: string | null;
    created_at: string;
    event_id: string | null;
    event_name: string;
  };
  buyer: {
    name: string | null;
    email: string | null;
    phone: string | null;
    registration_contact_id: string | null;
    user_id: string | null;
  };
  items: OrderItemDetail[];
  history: HistoryEntry[];
};

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function dateTime(value: string | null) {
  return value ? new Date(value).toLocaleString('pt-BR') : '-';
}

const HISTORY_ACTION_LABELS: Record<string, string> = {
  store_order_created: 'Pedido criado',
  store_order_item_delivered: 'Item entregue',
  store_order_item_delivery_undone: 'Entrega desfeita',
  store_order_cancelled: 'Pedido cancelado',
};

export default async function StoreOrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  await requireAnyPermission(['store.view', 'store.deliver']);

  const { orderId } = await params;
  const supabase = await createServerSupabaseClient();

  const [{ data, error }, permissionMap, { data: displayRow, error: displayError }] = await Promise.all([
    supabase.rpc('get_store_order_admin_detail', { p_store_order_id: orderId }),
    getCurrentPermissionMap(['store.manage', 'store.deliver']),
    supabase.from('store_orders').select('display_number,order_number').eq('id', orderId).maybeSingle(),
  ]);
  if (error) throw error;
  if (displayError) throw displayError;
  if (!data) notFound();

  const detail = data as unknown as OrderDetail;
  const canManage = Boolean(permissionMap['store.manage']);
  const canDeliver = Boolean(permissionMap['store.deliver']);
  const orderReference = orderDisplayReference(displayRow?.display_number, displayRow?.order_number);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <AdminPageHeader
            title={`Pedido ${orderReference}`}
            subtitle={detail.order.event_id ? detail.order.event_name : 'Produto global / Sem evento'}
            actions={<Link href="/loja/pedidos" className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">Voltar para pedidos</Link>}
            breadcrumbs={[
              { label: 'Início', href: '/painel' },
              { label: 'Loja', href: '/loja' },
              { label: 'Pedidos', href: '/loja/pedidos' },
              { label: orderReference },
            ]}
            backHref="/loja/pedidos"
          />

          <AdminSection title="Pedido" description={dateTime(detail.order.created_at)}>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs text-slate-400">Status</p>
                <AdminStatusBadge status={detail.order.status} />
              </div>
              <div>
                <p className="text-xs text-slate-400">Pagamento</p>
                <AdminStatusBadge status={detail.order.payment_status} />
              </div>
              <div>
                <p className="text-xs text-slate-400">Evento</p>
                <p className="text-sm text-slate-100">{detail.order.event_id ? detail.order.event_name : <span className="text-amber-300">Produto global / Sem evento</span>}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Criado em</p>
                <p className="text-sm text-slate-100">{dateTime(detail.order.created_at)}</p>
              </div>
            </div>
            {canManage ? (
              <div className="mt-4">
                <OrderPaymentActions storeOrderId={detail.order.id} status={detail.order.status} />
              </div>
            ) : null}
          </AdminSection>

          <AdminSection title="Comprador">
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <p className="text-xs text-slate-400">Nome</p>
                <p className="text-sm text-slate-100">{detail.buyer.name || 'Não identificado'}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">E-mail</p>
                <p className="text-sm text-slate-100">{detail.buyer.email || '-'}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Telefone</p>
                <p className="text-sm text-slate-100">{detail.buyer.phone || '-'}</p>
              </div>
            </div>
            {detail.buyer.registration_contact_id ? (
              <Link
                href={`/cadastros/${detail.buyer.registration_contact_id}`}
                className="mt-3 inline-flex h-9 items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-200"
              >
                Abrir cadastro do comprador
              </Link>
            ) : null}
          </AdminSection>

          <AdminSection title="Itens" description={`${detail.items.length} item(ns)`}>
            <div className="space-y-3">
              {detail.items.map((item) => (
                <div id={`item-${item.id}`} key={item.id} className="scroll-mt-6 flex gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-3">
                  {item.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.image_url} alt="" className="h-16 w-16 shrink-0 rounded-xl border border-slate-800 object-cover" />
                  ) : (
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl border border-dashed border-slate-700 text-[10px] text-slate-500">Sem foto</div>
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-slate-100">
                        {item.quantity}x {item.name}
                        {item.variant_name ? <span className="text-slate-400"> — {item.variant_name}: {item.variant_value}</span> : null}
                      </p>
                      <AdminStatusBadge status={item.status} />
                    </div>
                    <p className="text-xs text-slate-400">
                      Unitário {money(item.unit_price)}
                      {item.discount_value > 0 ? ` · Desconto ${item.discount_type === 'percentage' ? `${item.discount_value}%` : money(item.discount_value)}` : ''}
                      {' '}· Subtotal <span className="font-semibold text-slate-200">{money(item.final_amount)}</span>
                    </p>
                    {item.delivered_at ? <p className="text-xs text-slate-500">Entregue em {dateTime(item.delivered_at)}</p> : null}
                    {canDeliver ? (
                      <div className="pt-1">
                        <OrderItemActions storeOrderId={detail.order.id} itemId={item.id} status={item.status} hasQr={item.has_qr} />
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </AdminSection>

          <AdminSection title="Pagamento">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs text-slate-400">Método</p>
                <p className="text-sm text-slate-100">{detail.order.payment_method ?? 'Não informado'}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Valor bruto</p>
                <p className="text-sm text-slate-100">{money(detail.order.base_amount)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Desconto</p>
                <p className="text-sm text-slate-100">{money(detail.order.discount_amount)}</p>
              </div>
              <div>
                <p className="text-xs text-slate-400">Valor final</p>
                <p className="text-sm font-semibold text-white">{money(detail.order.final_amount)}</p>
              </div>
              {detail.order.gateway_payment_id ? (
                <div className="sm:col-span-2 lg:col-span-4">
                  <p className="text-xs text-slate-400">Gateway payment ID</p>
                  <p className="font-mono text-xs text-slate-300">{detail.order.gateway_payment_id}</p>
                </div>
              ) : null}
            </div>
          </AdminSection>

          <AdminSection title="Entrega e histórico">
            {detail.history.length === 0 ? (
              <p className="text-sm text-slate-400">Nenhum evento registrado ainda para este pedido.</p>
            ) : (
              <ul className="space-y-2 text-sm text-slate-300">
                {detail.history.map((entry, index) => (
                  <li key={index} className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                    <p className="text-slate-100">{HISTORY_ACTION_LABELS[entry.action] ?? entry.action}</p>
                    <p className="text-xs text-slate-400">{entry.actor_name} · {dateTime(entry.created_at)}</p>
                  </li>
                ))}
              </ul>
            )}
          </AdminSection>
        </div>
      </div>
    </main>
  );
}
