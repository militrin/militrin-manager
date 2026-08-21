"use client";

import { useEffect, useState } from "react";
import { getGrantableStoreItemsAction } from "../actions";
import type { ActionResult } from "../types";

type GrantableVariant = { id: string; name: string; value: string; priceAdjustment: number; availableQuantity: number | null };
type GrantableItem = {
  id: string;
  name: string;
  price: number;
  discountType: "percentage" | "fixed" | null;
  discountValue: number;
  finalPrice: number;
  requiresVariant: boolean;
  supplyMode: "stock" | "made_to_order";
  visibility: "public" | "code_required" | "admin_only";
  linkedToEventKit: boolean;
  variants: GrantableVariant[];
  availableQuantity: number | null;
};

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
}

const VISIBILITY_LABEL: Record<GrantableItem["visibility"], string> = {
  public: "Público",
  code_required: "Somente com código",
  admin_only: "Somente administrativo",
};

export function GrantStoreItemModal({
  eventId,
  events,
  onSubmit,
  onClose,
}: {
  eventId?: string;
  events?: Array<{ id: string; name: string }>;
  onSubmit: (payload: { eventId: string; storeItemId: string; variantId: string | null; quantity: number; isCourtesy: boolean; reason?: string }) => Promise<ActionResult>;
  onClose: () => void;
}) {
  const [selectedEventId, setSelectedEventId] = useState(eventId ?? "");
  const [loading, setLoading] = useState(Boolean(eventId));
  const [items, setItems] = useState<GrantableItem[]>([]);
  const [storeItemId, setStoreItemId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [isCourtesy, setIsCourtesy] = useState(true);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedEventId) return;
    let cancelled = false;
    void (async () => {
      const result = await getGrantableStoreItemsAction(selectedEventId);
      if (cancelled) return;
      setItems(result.success ? (result.items as GrantableItem[]) : []);
      if (!result.success) setError(result.message);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selectedEventId]);

  function selectEvent(nextEventId: string) {
    setSelectedEventId(nextEventId);
    setItems([]);
    setStoreItemId("");
    setVariantId("");
    setError(null);
    setLoading(Boolean(nextEventId));
  }

  const selectedItem = items.find((item) => item.id === storeItemId) ?? null;
  const selectedVariant = selectedItem?.variants.find((variant) => variant.id === variantId) ?? null;
  const availableQuantity = selectedItem?.requiresVariant ? selectedVariant?.availableQuantity ?? null : selectedItem?.availableQuantity ?? null;
  const outOfStock = availableQuantity !== null && availableQuantity <= 0;

  async function handleSubmit() {
    if (!selectedEventId) { setError("Selecione um evento."); return; }
    if (!storeItemId) { setError("Selecione um produto."); return; }
    if (selectedItem?.requiresVariant && !variantId) { setError("Selecione a variante/tamanho."); return; }
    setSubmitting(true);
    setError(null);
    const result = await onSubmit({
      eventId: selectedEventId,
      storeItemId,
      variantId: selectedItem?.requiresVariant ? variantId : null,
      quantity,
      isCourtesy,
      reason: reason.trim() || undefined,
    });
    setSubmitting(false);
    if (!result || !("success" in result) || !result.success) {
      setError((result && "message" in result ? result.message : null) ?? "Não foi possível conceder o item.");
      return;
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-3xl border border-emerald-500/30 bg-slate-950 p-5 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-slate-100">Adicionar item</h3>
        <p className="mt-1 text-sm text-slate-400">Concede um produto da loja para este participante, separado do kit do ingresso.</p>

        {events ? (
          <label className="mt-4 block space-y-1">
            <span className="text-xs text-slate-300">Evento</span>
            <select
              value={selectedEventId}
              onChange={(e) => selectEvent(e.target.value)}
              className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100"
            >
              <option value="">Selecione</option>
              {events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
            </select>
          </label>
        ) : null}

        {!selectedEventId ? (
          <p className="mt-4 text-sm text-slate-400">Selecione um evento para carregar os produtos.</p>
        ) : loading ? (
          <p className="mt-4 text-sm text-slate-400">Carregando produtos...</p>
        ) : items.length === 0 ? (
          <p className="mt-4 text-sm text-amber-300">Nenhum produto cadastrado para este evento.</p>
        ) : (
          <>
            <label className="mt-4 block space-y-1">
              <span className="text-xs text-slate-300">Produto</span>
              <select
                value={storeItemId}
                onChange={(e) => { setStoreItemId(e.target.value); setVariantId(""); }}
                className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100"
              >
                <option value="">Selecione</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {VISIBILITY_LABEL[item.visibility]}{item.linkedToEventKit ? " · estoque do evento" : ""}
                  </option>
                ))}
              </select>
            </label>

            {selectedItem?.requiresVariant ? (
              <label className="mt-3 block space-y-1">
                <span className="text-xs text-slate-300">Variante/tamanho</span>
                <select
                  value={variantId}
                  onChange={(e) => setVariantId(e.target.value)}
                  className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100"
                >
                  <option value="">Selecione</option>
                  {selectedItem.variants.map((variant) => (
                    <option key={variant.id} value={variant.id} disabled={variant.availableQuantity !== null && variant.availableQuantity <= 0}>
                      {variant.name} {variant.value}
                      {variant.availableQuantity !== null ? ` — ${variant.availableQuantity <= 0 ? "esgotado" : `${variant.availableQuantity} disponível(is)`}` : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="mt-3 block space-y-1">
              <span className="text-xs text-slate-300">Quantidade</span>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100"
              />
            </label>

            {outOfStock ? <p className="mt-2 text-xs text-rose-300">Sem estoque disponível para esta opção.</p> : null}

            <div className="mt-3 flex flex-col gap-1.5 text-xs text-slate-300">
              <label className="flex items-center gap-2">
                <input type="radio" checked={isCourtesy} onChange={() => setIsCourtesy(true)} />
                Cortesia — sem cobrança
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={!isCourtesy} onChange={() => setIsCourtesy(false)} />
                Cobrar — preço normal do produto
                {selectedItem ? (() => {
                  const baseUnit = selectedItem.price + (selectedVariant?.priceAdjustment ?? 0);
                  const finalUnit = selectedItem.discountType === "percentage" ? Math.max(baseUnit * (1 - Math.min(selectedItem.discountValue, 100) / 100), 0)
                    : selectedItem.discountType === "fixed" ? Math.max(baseUnit - selectedItem.discountValue, 0)
                    : baseUnit;
                  return selectedItem.discountType && finalUnit < baseUnit ? (
                    <span> (<span className="line-through">{money(baseUnit)}</span> {money(finalUnit)})</span>
                  ) : (
                    <span> ({money(baseUnit)})</span>
                  );
                })() : null}
              </label>
            </div>

            <label className="mt-3 block space-y-1">
              <span className="text-xs text-slate-300">Motivo/observação (opcional)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              />
            </label>
          </>
        )}

        {error ? <p className="mt-2 text-xs text-rose-300" role="alert">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={submitting} className="h-10 rounded-xl border border-slate-700 px-4 text-sm text-slate-300 disabled:opacity-50">
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || loading || !selectedEventId || items.length === 0 || outOfStock}
            className="h-10 rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-emerald-950 disabled:opacity-50"
          >
            {submitting ? "Concedendo..." : "Conceder item"}
          </button>
        </div>
      </div>
    </div>
  );
}
