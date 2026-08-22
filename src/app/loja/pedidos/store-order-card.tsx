import Link from 'next/link';
import { AdminStatusBadge } from '@/components/admin';

export type StoreOrderRow = {
  store_order_id: string;
  order_number: string;
  status: string;
  payment_method: string | null;
  payment_status: string;
  base_amount: number;
  final_amount: number;
  event_id: string | null;
  event_name: string;
  buyer_name: string | null;
  buyer_email: string | null;
  item_count: number;
  delivery_status: 'not_applicable' | 'pending' | 'partial' | 'delivered' | 'cancelled';
  created_at: string;
};

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function deliveryLabel(status: StoreOrderRow['delivery_status']) {
  switch (status) {
    case 'delivered':
      return { label: 'Entregue', className: 'border-cyan-500/40 bg-cyan-500/15 text-cyan-200' };
    case 'partial':
      return { label: 'Entrega parcial', className: 'border-sky-500/40 bg-sky-500/15 text-sky-200' };
    case 'pending':
      return { label: 'A entregar', className: 'border-amber-500/40 bg-amber-500/15 text-amber-200' };
    case 'cancelled':
      return { label: 'Cancelado', className: 'border-rose-500/40 bg-rose-500/15 text-rose-200' };
    default:
      return { label: 'Sem entrega pendente', className: 'border-slate-600 bg-slate-800/70 text-slate-200' };
  }
}

export function StoreOrderCard({ order }: { order: StoreOrderRow }) {
  const discount = Math.max(order.base_amount - order.final_amount, 0);
  const delivery = deliveryLabel(order.delivery_status);

  return (
    <Link
      href={`/loja/pedidos/${order.store_order_id}`}
      className="flex flex-col gap-2 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 transition hover:border-emerald-500/40"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs text-slate-400">{order.order_number}</p>
        <AdminStatusBadge status={order.status} />
      </div>

      <div>
        <p className="font-medium text-slate-100">{order.buyer_name || 'Comprador não identificado'}</p>
        <p className="text-xs text-slate-400">{order.buyer_email || 'Sem e-mail cadastrado'}</p>
      </div>

      <p className="text-xs text-slate-400">
        {order.event_id ? order.event_name : <span className="text-amber-300">Produto global / Sem evento</span>}
      </p>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <AdminStatusBadge status={order.payment_status} />
        <span className={`inline-flex rounded-full border px-2.5 py-1 font-medium ${delivery.className}`}>{delivery.label}</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-slate-400">{order.item_count} item(ns)</span>
        <span className="font-semibold text-white">
          {money(order.final_amount)}
          {discount > 0 ? <span className="ml-1 text-xs text-emerald-300">(-{money(discount)})</span> : null}
        </span>
      </div>

      <p className="text-xs text-slate-500">{new Date(order.created_at).toLocaleString('pt-BR')}</p>
    </Link>
  );
}
