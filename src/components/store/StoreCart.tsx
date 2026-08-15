'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MilitrinButton } from '@/components/militrin';
import {
  createAccountStoreOrderAction,
  generateStoreOrderPixAction,
  type StoreCartLine,
} from '@/lib/store/actions';
import type { StoreItemForPurchase } from '@/lib/store/get-store-items';
import { StorePaymentPanel, type StorePaymentState } from './StorePaymentPanel';
import { ItemDetailModal, ItemVariantSelect, QuantityStepper, isSoldOut, money, type Selection } from './store-item-controls';

type CartLine = { variantId: string | null; quantity: number };

export function StoreCart({ eventId, items }: { eventId: string; items: StoreItemForPurchase[] }) {
  const router = useRouter();
  const [cart, setCart] = useState<Record<string, CartLine>>({});
  const [selection, setSelection] = useState<Record<string, Selection>>({});
  const [itemErrors, setItemErrors] = useState<Record<string, string | null>>({});
  const [addedItemId, setAddedItemId] = useState<string | null>(null);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'pix' | 'credit_card'>('pix');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<StorePaymentState | null>(null);

  const lines = useMemo(() => {
    return items
      .map((item) => {
        const cartLine = cart[item.id];
        if (!cartLine || cartLine.quantity <= 0) return null;
        const variant = item.variants.find((v) => v.id === cartLine.variantId) ?? null;
        if (item.requiresVariant && !variant) return null;
        const unitPrice = item.price + (variant?.priceAdjustment ?? 0);
        return { item, variant, quantity: cartLine.quantity, lineTotal: unitPrice * cartLine.quantity };
      })
      .filter((line): line is NonNullable<typeof line> => line !== null);
  }, [cart, items]);

  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const itemCount = lines.reduce((sum, line) => sum + line.quantity, 0);

  function getSelection(itemId: string): Selection {
    return selection[itemId] ?? { variantId: null, quantity: 1 };
  }

  function setSelectionQuantity(itemId: string, quantity: number) {
    setSelection((prev) => ({ ...prev, [itemId]: { variantId: prev[itemId]?.variantId ?? null, quantity: Math.max(1, quantity) } }));
  }

  function setSelectionVariant(itemId: string, variantId: string) {
    setSelection((prev) => ({ ...prev, [itemId]: { variantId, quantity: prev[itemId]?.quantity ?? 1 } }));
    setItemErrors((prev) => ({ ...prev, [itemId]: null }));
  }

  function addToCart(item: StoreItemForPurchase) {
    const sel = getSelection(item.id);
    if (item.requiresVariant && !sel.variantId) {
      setItemErrors((prev) => ({ ...prev, [item.id]: 'Escolha uma opção antes de adicionar.' }));
      return;
    }
    setCart((prev) => {
      const existing = prev[item.id];
      const sameVariant = existing && existing.variantId === sel.variantId;
      const quantity = sameVariant ? existing.quantity + sel.quantity : sel.quantity;
      return { ...prev, [item.id]: { variantId: sel.variantId, quantity } };
    });
    setItemErrors((prev) => ({ ...prev, [item.id]: null }));
    setAddedItemId(item.id);
    window.setTimeout(() => setAddedItemId((current) => (current === item.id ? null : current)), 1500);
  }

  function removeLine(itemId: string) {
    setCart((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }

  function submit() {
    const cartItems: StoreCartLine[] = lines.map((line) => ({ storeItemId: line.item.id, variantId: line.variant?.id ?? null, quantity: line.quantity }));
    startTransition(async () => {
      const response = await createAccountStoreOrderAction({ eventId, items: cartItems, paymentMethod });
      if (!response.success) {
        setError(response.message);
        return;
      }
      setCart({});
      setError(null);
      setCartOpen(false);
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

  if (payment) {
    return (
      <div className="space-y-4">
        <StorePaymentPanel state={payment} onChange={setPayment} />
        {payment.status === 'paid' || payment.paymentMethod !== 'pix' ? (
          <button type="button" onClick={() => setPayment(null)} className="text-xs text-slate-400 underline">
            Comprar mais itens
          </button>
        ) : null}
      </div>
    );
  }

  const openItem = openItemId ? items.find((item) => item.id === openItemId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {items.map((item) => {
          const soldOut = isSoldOut(item);
          const sel = getSelection(item.id);
          return (
            <div key={item.id} className="flex gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
              <button
                type="button"
                onClick={() => setOpenItemId(item.id)}
                className="h-16 w-16 shrink-0 cursor-zoom-in overflow-hidden rounded-xl border border-slate-800"
                aria-label={`Ver ${item.name} em detalhe`}
              >
                {item.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.imageUrl} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[10px] text-slate-500">Sem foto</div>
                )}
              </button>
              <div className="min-w-0 flex-1">
                <button type="button" onClick={() => setOpenItemId(item.id)} className="text-left font-semibold text-white hover:underline">
                  {item.name}
                  {item.supplyMode === 'made_to_order' ? (
                    <span className="ml-2 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] font-normal text-sky-200">Por encomenda</span>
                  ) : null}
                </button>
                <p className="text-sm text-(--brand-300)">{money(item.price)}</p>
                {item.description ? <p className="mt-1 line-clamp-2 text-xs text-slate-400">{item.description}</p> : null}

                {soldOut ? (
                  <p className="mt-2 text-xs text-rose-300">Esgotado</p>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <ItemVariantSelect item={item} selection={sel} onChange={(variantId) => setSelectionVariant(item.id, variantId)} />
                    <QuantityStepper value={sel.quantity} onChange={(quantity) => setSelectionQuantity(item.id, quantity)} />
                    <button
                      type="button"
                      onClick={() => addToCart(item)}
                      className="inline-flex h-8 items-center rounded-lg border border-(--brand-400)/40 bg-(--brand-500)/10 px-3 text-xs font-medium text-(--brand-200)"
                    >
                      {addedItemId === item.id ? 'Adicionado!' : 'Adicionar ao carrinho'}
                    </button>
                  </div>
                )}
                {itemErrors[item.id] ? <p className="mt-1 text-xs text-rose-300">{itemErrors[item.id]}</p> : null}
              </div>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => setCartOpen(true)}
        className="fixed bottom-4 right-4 z-30 flex items-center gap-2 rounded-full border border-(--brand-400)/40 bg-(--brand-500) px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-black/40"
      >
        <span aria-hidden="true">🛒</span>
        Carrinho{itemCount > 0 ? ` (${itemCount}) — ${money(total)}` : ''}
      </button>

      {cartOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/80 p-0 sm:items-center sm:p-4" onClick={() => setCartOpen(false)}>
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-slate-700 bg-slate-900 p-6 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <p className="text-lg font-semibold text-white">Seu carrinho</p>
              <button type="button" onClick={() => setCartOpen(false)} className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800">
                Fechar
              </button>
            </div>

            {lines.length === 0 ? (
              <p className="mt-4 text-sm text-slate-400">Seu carrinho está vazio. Adicione itens da loja para continuar.</p>
            ) : (
              <>
                <ul className="mt-4 space-y-2 text-sm text-slate-200">
                  {lines.map((line) => (
                    <li key={`${line.item.id}-${line.variant?.id ?? 'na'}`} className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
                      {line.item.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={line.item.imageUrl} alt="" className="h-10 w-10 shrink-0 rounded-lg border border-slate-800 object-cover" />
                      ) : (
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-dashed border-slate-700 text-[9px] text-slate-500">Sem foto</div>
                      )}
                      <span className="min-w-0 flex-1">
                        {line.quantity}x {line.item.name}{line.variant ? ` — ${line.variant.name}: ${line.variant.value}` : ''} — {money(line.lineTotal)}
                      </span>
                      <button type="button" onClick={() => removeLine(line.item.id)} className="shrink-0 text-xs text-rose-300 underline">
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
        </div>
      ) : null}

      {openItem ? (
        <ItemDetailModal
          item={openItem}
          selection={getSelection(openItem.id)}
          onClose={() => setOpenItemId(null)}
          onQuantityChange={(quantity) => setSelectionQuantity(openItem.id, quantity)}
          onVariantChange={(variantId) => setSelectionVariant(openItem.id, variantId)}
          onAddToCart={() => addToCart(openItem)}
          errorMessage={itemErrors[openItem.id] ?? null}
          added={addedItemId === openItem.id}
        />
      ) : null}
    </div>
  );
}
