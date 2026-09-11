'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { MilitrinButton, MilitrinStatusBadge } from '@/components/militrin';
import { PixCodeBox } from '@/components/public/PixCodeBox';
import { cancelAccountStoreOrderAction, simulateStoreOrderPaymentAction } from './actions';
import { isSyntheticGatewayPayload } from '@/lib/payments/synthetic-gateway-payload';
import { accountStoreOrderHref } from '@/lib/store/get-account-store-orders';
import { orderDisplayReference } from '@/lib/display-reference';

const canSimulatePayment = process.env.NODE_ENV === 'development';

type OrderItem = {
  id: string;
  quantity: number;
  final_amount: number;
  status: string;
  store_items: { name: string } | { name: string }[] | null;
  store_item_variants: { name: string; value: string } | { name: string; value: string }[] | null;
};

type Order = {
  id: string;
  order_number: string;
  display_number: number;
  status: string;
  payment_method: string | null;
  payment_status?: string | null;
  final_amount: number;
  pix_code: string | null;
  pix_qrcode: string | null;
  expires_at: string | null;
  created_at: string;
  store_order_items: OrderItem[];
};

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function OrderRow({ order }: { order: Order }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const orderHref = accountStoreOrderHref(order.id);
  const isPending = order.status === 'pending';
  const showPix = isPending && order.payment_method === 'pix' && order.pix_code
    && !isSyntheticGatewayPayload({ pixCode: order.pix_code, pixQrCode: order.pix_qrcode });
  const showCard = isPending && order.payment_method === 'credit_card';

  useEffect(() => {
    if (!showPix || !order.expires_at) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [showPix, order.expires_at]);

  const remainingSeconds = order.expires_at ? Math.max(0, Math.floor((new Date(order.expires_at).getTime() - now) / 1000)) : null;

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-300">Pedido {orderDisplayReference(order.display_number, order.order_number)}</p>
        <MilitrinStatusBadge status={order.status} />
      </div>
      <ul className="mt-2 space-y-0.5 text-xs text-slate-300">
        {order.store_order_items.map((item) => {
          const storeItem = one(item.store_items);
          const variant = one(item.store_item_variants);
          return (
            <li key={item.id}>
              {item.quantity}x {storeItem?.name ?? 'Item'}{variant ? ` — ${variant.name}: ${variant.value}` : ''} — {money(item.final_amount)}
            </li>
          );
        })}
      </ul>
      <p className="mt-1 text-sm font-semibold text-white">{money(order.final_amount)}</p>
      {order.payment_method ? <p className="text-xs text-slate-500">{order.payment_method === 'credit_card' ? 'Cartão' : order.payment_method === 'pix' ? 'PIX' : order.payment_method}</p> : null}

      {showPix ? (
        <div className="mt-2 space-y-2 rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-200">
          <p className="text-xs font-medium">Pagamento via PIX pendente:</p>
          <PixCodeBox code={order.pix_code ?? ''} />
          {order.pix_qrcode ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={order.pix_qrcode} alt="QR Code PIX" className="h-36 w-36 rounded-lg border border-slate-700 bg-white p-2" />
          ) : null}
          {remainingSeconds !== null ? (
            <p className="text-xs text-slate-400">
              {remainingSeconds > 0 ? `Expira em ${Math.floor(remainingSeconds / 60)}m ${remainingSeconds % 60}s` : 'Código expirado.'}
            </p>
          ) : null}
        </div>
      ) : null}

      {showCard ? (
        <p className="mt-2 text-xs text-slate-400">Cartão pendente ou em processamento. Abra o pedido para pagar ou tentar novamente.</p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Link href={orderHref} className="inline-flex h-8 items-center rounded-lg border border-slate-600 px-3 text-xs text-slate-200">
          Abrir pedido
        </Link>
        {isPending ? (
          <>
            {showPix && canSimulatePayment ? (
              <MilitrinButton
                size="sm"
                variant="success"
                disabled={pending}
                onClick={() => startTransition(async () => setMessage((await simulateStoreOrderPaymentAction(order.id, 'pix')).message))}
              >
                {pending ? 'Processando...' : 'Pagar agora (simulado dev)'}
              </MilitrinButton>
            ) : null}
            <button
              type="button"
              disabled={pending}
              onClick={() => startTransition(async () => setMessage((await cancelAccountStoreOrderAction(order.id)).message))}
              className="inline-flex h-8 items-center rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 text-xs text-rose-200 disabled:opacity-50"
            >
              Cancelar pedido
            </button>
          </>
        ) : null}
      </div>
      {message ? <p className="mt-1 text-xs text-slate-400" role="status">{message}</p> : null}
    </div>
  );
}

export function AccountStoreOrders({ orders }: { orders: Order[] }) {
  return (
    <div className="space-y-2">
      {orders.map((order) => (
        <OrderRow key={order.id} order={order} />
      ))}
    </div>
  );
}
