"use client";

import { useState, useTransition } from "react";
import { cancelStoreOrderAction, confirmStoreOrderPaymentAction, deliverStoreOrderItemAction, undoStoreOrderItemDeliveryAction } from "./actions";

type OrderItem = {
  id: string;
  quantity: number;
  unit_price: number;
  final_amount: number;
  status: string;
  store_items: { name: string } | { name: string }[] | null;
  store_item_variants: { name: string; value: string } | { name: string; value: string }[] | null;
};

type Order = {
  id: string;
  order_number: string;
  status: string;
  payment_method: string | null;
  payment_status: string;
  final_amount: number;
  created_at: string;
  confirmed_at: string | null;
  store_order_items: OrderItem[];
};

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
}

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function OrderRow({ order, canManage, canDeliver }: { order: Order; canManage: boolean; canDeliver: boolean }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-mono text-xs text-slate-400">{order.order_number}</p>
          <p className="text-sm text-slate-200">{money(order.final_amount)} · {order.payment_method ?? "sem método"} · <span className="text-slate-400">{order.status}</span></p>
        </div>
        {canManage && order.status === "pending" ? (
          <div className="flex gap-2">
            <button
              type="button" disabled={pending}
              onClick={() => startTransition(async () => setMessage((await confirmStoreOrderPaymentAction(order.id)).message))}
              className="inline-flex h-8 items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200 disabled:opacity-50"
            >
              Confirmar pagamento
            </button>
            <button
              type="button" disabled={pending}
              onClick={() => startTransition(async () => setMessage((await cancelStoreOrderAction(order.id, "Cancelado pela administração")).message))}
              className="inline-flex h-8 items-center rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 text-xs text-rose-200 disabled:opacity-50"
            >
              Cancelar
            </button>
          </div>
        ) : null}
      </div>

      <div className="mt-2 space-y-1">
        {order.store_order_items.map((item) => {
          const storeItem = one(item.store_items);
          const variant = one(item.store_item_variants);
          return (
            <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/40 px-2 py-1 text-xs text-slate-300">
              <span>
                {item.quantity}x {storeItem?.name ?? "Item"}{variant ? ` — ${variant.name}: ${variant.value}` : ""} · {money(item.final_amount)} · {item.status}
              </span>
              {canDeliver && item.status === "confirmed" ? (
                <button
                  type="button" disabled={pending}
                  onClick={() => startTransition(async () => setMessage((await deliverStoreOrderItemAction(item.id)).message))}
                  className="inline-flex h-6 items-center rounded-lg border border-emerald-500/40 px-2 text-[11px] text-emerald-200 disabled:opacity-50"
                >
                  Entregar
                </button>
              ) : null}
              {canDeliver && item.status === "delivered" ? (
                <button
                  type="button" disabled={pending}
                  onClick={() => startTransition(async () => setMessage((await undoStoreOrderItemDeliveryAction(item.id)).message))}
                  className="inline-flex h-6 items-center rounded-lg border border-slate-700 px-2 text-[11px] text-slate-300 disabled:opacity-50"
                >
                  Desfazer entrega
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {message ? <p className="mt-1 text-xs text-slate-400" role="status">{message}</p> : null}
    </div>
  );
}

export function StoreOrdersList({ orders, canManage, canDeliver }: { orders: Order[]; canManage: boolean; canDeliver: boolean }) {
  return (
    <div className="space-y-2">
      {orders.map((order) => (
        <OrderRow key={order.id} order={order} canManage={canManage} canDeliver={canDeliver} />
      ))}
    </div>
  );
}
