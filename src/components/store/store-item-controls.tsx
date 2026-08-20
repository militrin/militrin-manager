'use client';

import type { ReactNode } from 'react';
import { MilitrinButton } from '@/components/militrin';
import type { StoreItemForPurchase } from '@/lib/store/get-store-items';
import { ProductImageGallery } from './product-image-gallery';

export type Selection = { variantId: string | null; quantity: number };

export function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

export function isSoldOut(item: StoreItemForPurchase) {
  return item.requiresVariant
    ? item.variants.every((v) => v.availableQuantity !== null && v.availableQuantity <= 0)
    : item.availableQuantity !== null && item.availableQuantity <= 0;
}

export function QuantityStepper({
  value,
  onChange,
  max,
  onExceedMax,
}: {
  value: number;
  onChange: (next: number) => void;
  /** Estoque conhecido; null/undefined = sem limite conhecido (por encomenda). */
  max?: number | null;
  /** Chamado ao clicar em "+" já no limite, em vez de silenciosamente nao fazer nada. */
  onExceedMax?: () => void;
}) {
  const atMax = typeof max === 'number' && value >= max;
  return (
    <div className="flex h-8 items-center overflow-hidden rounded-lg border border-slate-700 bg-slate-950 text-xs text-slate-100">
      <button type="button" onClick={() => onChange(Math.max(1, value - 1))} className="flex h-full w-7 items-center justify-center text-slate-300 hover:bg-slate-800" aria-label="Diminuir quantidade">
        −
      </button>
      <span className="flex h-full w-8 items-center justify-center border-x border-slate-700">{value}</span>
      <button
        type="button"
        onClick={() => (atMax ? onExceedMax?.() : onChange(value + 1))}
        aria-disabled={atMax || undefined}
        // Nao usa o atributo disabled: o clique continua sendo respondido pra
        // avisar o motivo (onExceedMax), so o estilo fica desabilitado -- um
        // botao inerte, sem nenhum feedback, e o que faz parecer quebrado.
        className={`flex h-full w-7 items-center justify-center ${atMax ? 'cursor-not-allowed text-slate-600' : 'text-slate-300 hover:bg-slate-800'}`}
        aria-label="Aumentar quantidade"
      >
        +
      </button>
    </div>
  );
}

export function ItemVariantSelect({ item, selection, onChange }: { item: StoreItemForPurchase; selection: Selection; onChange: (variantId: string) => void }) {
  if (!item.requiresVariant) return null;
  return (
    <select
      value={selection.variantId ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
    >
      <option value="">Escolha uma opção</option>
      {item.variants.map((variant) => (
        <option key={variant.id} value={variant.id} disabled={variant.availableQuantity !== null && variant.availableQuantity <= 0}>
          {variant.name}: {variant.value}{variant.availableQuantity !== null && variant.availableQuantity <= 0 ? ' (esgotado)' : ''}
        </option>
      ))}
    </select>
  );
}

export function ItemDetailModal({
  item,
  selection,
  onClose,
  onQuantityChange,
  onVariantChange,
  onAddToCart,
  errorMessage,
  added,
  notice,
  extraControl,
}: {
  item: StoreItemForPurchase;
  selection: Selection;
  onClose: () => void;
  onQuantityChange: (quantity: number) => void;
  onVariantChange: (variantId: string) => void;
  onAddToCart: () => void;
  errorMessage: string | null;
  added: boolean;
  notice?: ReactNode;
  extraControl?: ReactNode;
}) {
  const soldOut = isSoldOut(item);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-slate-700 bg-slate-900 p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xl font-bold text-white">{item.name}</h2>
          <button type="button" onClick={onClose} className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800">
            Fechar
          </button>
        </div>

        <div className="mt-4">
          <ProductImageGallery images={item.images} alt={item.name} />
        </div>

        <p className="mt-4 text-lg font-semibold text-(--brand-300)">{money(item.price)}</p>
        {item.supplyMode === 'made_to_order' ? (
          <span className="mt-1 inline-block rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-200">Por encomenda</span>
        ) : null}
        {item.description ? <p className="mt-2 text-sm text-slate-300">{item.description}</p> : null}
        {notice}

        {soldOut ? (
          <p className="mt-4 text-sm text-rose-300">Esgotado</p>
        ) : (
          <div className="mt-5 flex flex-wrap items-center gap-2">
            {extraControl}
            <ItemVariantSelect item={item} selection={selection} onChange={onVariantChange} />
            <QuantityStepper value={selection.quantity} onChange={onQuantityChange} />
            <MilitrinButton size="sm" onClick={onAddToCart}>
              {added ? 'Adicionado!' : 'Adicionar ao carrinho'}
            </MilitrinButton>
          </div>
        )}
        {errorMessage ? <p className="mt-2 text-xs text-rose-300">{errorMessage}</p> : null}
      </div>
    </div>
  );
}
