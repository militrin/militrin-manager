'use client';

import { useState } from 'react';
import { useStoreCart } from '@/lib/store/cart-context';
import type { StoreItemForPurchase } from '@/lib/store/get-store-items';
import { ItemDetailModal, ItemVariantSelect, QuantityStepper, isSoldOut, money, type Selection } from './store-item-controls';

type EventOption = { id: string; name: string };

function ExclusiveEventNotice({ eventName }: { eventName: string }) {
  return (
    <p className="mt-1 text-[11px] leading-snug text-amber-300">
      Exclusivo de {eventName} — retire no dia do evento ou nos dias de entrega de kit.
    </p>
  );
}

export function AccountStoreShop({ events, items }: { events: EventOption[]; items: StoreItemForPurchase[] }) {
  const { addLine } = useStoreCart();
  const [selection, setSelection] = useState<Record<string, Selection>>({});
  const [targetEvent, setTargetEvent] = useState<Record<string, string>>({});
  const [itemErrors, setItemErrors] = useState<Record<string, string | null>>({});
  const [addedItemId, setAddedItemId] = useState<string | null>(null);
  const [openItemId, setOpenItemId] = useState<string | null>(null);

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

  function eventNameFor(eventId: string) {
    return events.find((e) => e.id === eventId)?.name ?? 'Evento';
  }

  function resolveTargetEvent(item: StoreItemForPurchase): EventOption | null {
    if (item.eventId) return events.find((e) => e.id === item.eventId) ?? null;
    if (events.length === 1) return events[0];
    const chosenId = targetEvent[item.id] ?? events[0]?.id;
    return events.find((e) => e.id === chosenId) ?? events[0] ?? null;
  }

  function addToCart(item: StoreItemForPurchase) {
    const sel = getSelection(item.id);
    if (item.requiresVariant && !sel.variantId) {
      setItemErrors((prev) => ({ ...prev, [item.id]: 'Escolha uma opção antes de adicionar.' }));
      return;
    }
    const targetEventOption = resolveTargetEvent(item);
    if (!targetEventOption) {
      setItemErrors((prev) => ({ ...prev, [item.id]: 'Escolha para qual evento é esta compra.' }));
      return;
    }
    const variant = item.variants.find((v) => v.id === sel.variantId) ?? null;
    addLine({
      eventId: targetEventOption.id,
      eventName: targetEventOption.name,
      itemId: item.id,
      itemName: item.name,
      imageUrl: item.imageUrl,
      variantId: variant?.id ?? null,
      variantLabel: variant ? `${variant.name}: ${variant.value}` : null,
      unitPrice: item.price + (variant?.priceAdjustment ?? 0),
      quantity: sel.quantity,
      supplyMode: item.supplyMode,
    });
    setItemErrors((prev) => ({ ...prev, [item.id]: null }));
    setAddedItemId(item.id);
    setOpenItemId(null);
    window.setTimeout(() => setAddedItemId((current) => (current === item.id ? null : current)), 1500);
  }

  const openItem = openItemId ? items.find((item) => item.id === openItemId) ?? null : null;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {items.map((item) => {
        const soldOut = isSoldOut(item);
        const sel = getSelection(item.id);
        const needsEventPicker = item.eventId === null && events.length > 1;
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
              {item.eventId ? <ExclusiveEventNotice eventName={eventNameFor(item.eventId)} /> : null}

              {soldOut ? (
                <p className="mt-2 text-xs text-rose-300">Esgotado</p>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {needsEventPicker ? (
                    <select
                      value={targetEvent[item.id] ?? events[0]?.id ?? ''}
                      onChange={(e) => setTargetEvent((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      className="h-8 rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
                      aria-label="Para qual evento é esta compra"
                    >
                      {events.map((ev) => (
                        <option key={ev.id} value={ev.id}>Para: {ev.name}</option>
                      ))}
                    </select>
                  ) : null}
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
          notice={openItem.eventId ? <ExclusiveEventNotice eventName={eventNameFor(openItem.eventId)} /> : null}
          extraControl={
            openItem.eventId === null && events.length > 1 ? (
              <select
                value={targetEvent[openItem.id] ?? events[0]?.id ?? ''}
                onChange={(e) => setTargetEvent((prev) => ({ ...prev, [openItem.id]: e.target.value }))}
                className="h-8 rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
                aria-label="Para qual evento é esta compra"
              >
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>Para: {ev.name}</option>
                ))}
              </select>
            ) : null
          }
        />
      ) : null}
    </div>
  );
}
