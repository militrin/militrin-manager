'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MilitrinButton, MilitrinEmptyState } from '@/components/militrin';
import { useStoreCart, type AccountCartLine } from '@/lib/store/cart-context';
import { createAccountStoreOrderAction, generateStoreOrderPixAction, type StoreCartLine } from '@/lib/store/actions';
import { StorePaymentPanel, type StorePaymentState } from '@/components/store/StorePaymentPanel';
import { money, QuantityStepper } from '@/components/store/store-item-controls';

function EventCartGroup({ eventId, eventName, lines }: { eventId: string | null; eventName: string; lines: AccountCartLine[] }) {
  const router = useRouter();
  const { setQuantity, removeLine, clearEvent } = useStoreCart();
  const [paymentMethod, setPaymentMethod] = useState<'pix' | 'credit_card'>('pix');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<StorePaymentState | null>(null);

  const total = lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);

  function submit() {
    const cartItems: StoreCartLine[] = lines.map((line) => ({ storeItemId: line.itemId, variantId: line.variantId, quantity: line.quantity }));
    startTransition(async () => {
      const response = await createAccountStoreOrderAction({ eventId, items: cartItems, paymentMethod });
      if (!response.success) {
        setError(response.message);
        return;
      }
      setError(null);
      clearEvent(eventId);
      router.refresh();

      if (paymentMethod === 'pix' && response.finalAmount > 0) {
        const pix = await generateStoreOrderPixAction(response.storeOrderId, response.finalAmount);
        setPayment({
          storeOrderId: response.storeOrderId,
          orderNumber: response.orderNumber,
          finalAmount: response.finalAmount,
          paymentMethod,
          pixCode: pix.success ? pix.pixCode : null,
          pixQrCode: pix.success ? pix.pixQrCode : null,
          expiresAt: pix.success ? pix.expiresAt : null,
          status: 'awaiting_payment',
        });
        if (!pix.success) setError(pix.message);
      } else {
        setPayment({
          storeOrderId: response.storeOrderId,
          orderNumber: response.orderNumber,
          finalAmount: response.finalAmount,
          paymentMethod,
          pixCode: null,
          pixQrCode: null,
          expiresAt: null,
          status: 'awaiting_payment',
        });
      }
    });
  }

  const buyMoreHref = eventId ? `/minha-conta/loja?eventId=${eventId}` : '/minha-conta/loja';

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{eventId ? 'Evento' : 'Loja'}</p>
      <p className="text-lg font-semibold text-white">{eventName}</p>

      {payment ? (
        <div className="mt-4 space-y-3">
          <StorePaymentPanel state={payment} onChange={setPayment} />
          {payment.status === 'paid' || payment.paymentMethod !== 'pix' ? (
            <Link href={buyMoreHref} className="text-xs text-slate-400 underline">
              {eventId ? 'Comprar mais itens deste evento' : 'Comprar mais itens'}
            </Link>
          ) : null}
        </div>
      ) : (
        <>
          <ul className="mt-3 space-y-2 text-sm text-slate-200">
            {lines.map((line) => (
              <li key={`${line.itemId}-${line.variantId ?? 'na'}`} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                {line.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={line.imageUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg border border-slate-800 object-cover" />
                ) : (
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-dashed border-slate-700 text-[9px] text-slate-500">Sem foto</div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-white">
                    {line.itemName}
                    {line.variantLabel ? <span className="text-slate-400"> — {line.variantLabel}</span> : null}
                  </p>
                  <p className="text-xs text-slate-400">{money(line.unitPrice)} cada — subtotal {money(line.unitPrice * line.quantity)}</p>
                </div>
                <QuantityStepper value={line.quantity} onChange={(quantity) => setQuantity(eventId, line.itemId, quantity)} />
                <button type="button" onClick={() => removeLine(eventId, line.itemId)} className="shrink-0 text-xs text-rose-300 underline">
                  Remover
                </button>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-sm font-semibold text-white">Total: {money(total)}</p>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1 text-xs text-slate-200">
              <input type="radio" checked={paymentMethod === 'pix'} onChange={() => setPaymentMethod('pix')} /> PIX
            </label>
            <label className="flex items-center gap-1 text-xs text-slate-200">
              <input type="radio" checked={paymentMethod === 'credit_card'} onChange={() => setPaymentMethod('credit_card')} /> Cartão de crédito
            </label>
          </div>

          <MilitrinButton className="mt-3" size="sm" disabled={pending} onClick={submit}>
            {pending ? 'Enviando...' : 'Finalizar pedido e ir para pagamento'}
          </MilitrinButton>
          {error ? <p className="mt-2 text-xs text-rose-300" role="status">{error}</p> : null}
        </>
      )}
    </div>
  );
}

export function CartPageClient() {
  const { lines } = useStoreCart();

  const groups = useMemo(() => {
    const byEvent = new Map<string, { eventId: string | null; eventName: string; lines: AccountCartLine[] }>();
    for (const line of lines) {
      const key = line.eventId ?? '__global__';
      const group = byEvent.get(key) ?? { eventId: line.eventId, eventName: line.eventId ? line.eventName : 'Loja Militrin', lines: [] };
      group.lines.push(line);
      byEvent.set(key, group);
    }
    return Array.from(byEvent.values());
  }, [lines]);

  if (groups.length === 0) {
    return (
      <MilitrinEmptyState
        title="Seu carrinho está vazio"
        description="Visite a loja de um evento e adicione itens para vê-los aqui."
        actionHref="/minha-conta/loja"
        actionLabel="Ir para a loja"
      />
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <EventCartGroup key={group.eventId ?? '__global__'} eventId={group.eventId} eventName={group.eventName} lines={group.lines} />
      ))}
    </div>
  );
}
