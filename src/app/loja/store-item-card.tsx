"use client";

import { useState, useTransition } from "react";
import { StoreItemForm } from "./store-item-form";
import { StoreItemImageGallery } from "./store-item-image-gallery";
import { StoreItemVariantForm } from "./store-item-variant-form";
import { StoreStockInput } from "./store-stock-input";
import { deleteStoreItemAction, setStoreItemActiveAction, syncLinkedStoreItemVariantsAction } from "./actions";

type EventOption = { id: string; name: string; year: number | null; is_active: boolean };

type StoreItemVariant = {
  id: string;
  name: string;
  value: string;
  priceAdjustment: number;
  totalQuantity: number;
  reservedQuantity: number;
  deliveredQuantity: number;
  availableQuantity: number;
  linkedEventKitItemVariantId: string | null;
};

type StoreItemImage = { id: string; url: string; isPrimary: boolean };

type StoreItem = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  primaryImageUrl: string | null;
  images: StoreItemImage[];
  price: number;
  discountType: "percentage" | "fixed" | null;
  discountValue: number;
  finalPrice: number;
  requiresVariant: boolean;
  sortOrder: number;
  supplyMode: "stock" | "made_to_order";
  visibility: "public" | "code_required" | "admin_only";
  isActive: boolean;
  eventId: string | null;
  eventLabel: string;
  linkedEventKitItemId: string | null;
  linkedEventKitItemName: string | null;
  variants: StoreItemVariant[];
  totalQuantity: number;
  reservedQuantity: number;
  deliveredQuantity: number;
  availableQuantity: number;
};

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
}

const VISIBILITY_BADGE: Record<StoreItem["visibility"], { label: string; className: string }> = {
  public: { label: "Público", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" },
  code_required: { label: "Somente com código", className: "border-amber-500/40 bg-amber-500/10 text-amber-200" },
  admin_only: { label: "Somente administrativo", className: "border-rose-500/40 bg-rose-500/10 text-rose-200" },
};

export function StoreItemCard({
  events,
  item,
  canManage,
}: {
  events: EventOption[];
  item: StoreItem;
  canManage: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const isLinked = Boolean(item.linkedEventKitItemId);
  const hasDiscount = Boolean(item.discountType) && item.discountValue > 0 && item.finalPrice < item.price;
  // "Indisponivel" (sem estoque, produto ainda ATIVO) e um estado DIFERENTE
  // de "Desativado" (is_active=false) -- nunca tratados como sinonimos.
  const isUnavailable = item.isActive && item.supplyMode === "stock" && !item.requiresVariant && item.availableQuantity <= 0;
  const discountLabel = item.discountType === "percentage" ? `-${item.discountValue}%` : item.discountType === "fixed" ? `-${money(item.discountValue)}` : null;

  function handleSetActive(isActive: boolean) {
    setStatusMessage(null);
    startTransition(async () => {
      const result = await setStoreItemActiveAction(item.id, isActive);
      setStatusMessage(result.message);
    });
  }

  function handleDelete() {
    setStatusMessage(null);
    startTransition(async () => {
      const result = await deleteStoreItemAction(item.id);
      setStatusMessage(result.message);
      setConfirmingDelete(false);
    });
  }

  return (
    <div className={`rounded-2xl border p-4 ${item.isActive ? "border-slate-800 bg-slate-950/40" : "border-slate-800/60 bg-slate-950/20 opacity-75"}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          {item.primaryImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.primaryImageUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg border border-slate-800 object-cover" />
          ) : null}
          <div>
            <p className="font-semibold text-white">
              {item.name}{" "}
              {hasDiscount ? (
                <span className="ml-1 text-xs font-normal">
                  <span className="text-slate-500 line-through">{money(item.price)}</span>{" "}
                  <span className="text-emerald-300">{money(item.finalPrice)}</span>{" "}
                  <span className="text-emerald-400">{discountLabel}</span>
                </span>
              ) : (
                <span className="ml-1 text-xs font-normal text-slate-500">{money(item.price)}</span>
              )}
              {!item.isActive ? (
                <span className="ml-2 rounded-full border border-slate-500/40 bg-slate-700/30 px-2 py-0.5 text-[10px] text-slate-300">Desativado</span>
              ) : isUnavailable ? (
                <span className="ml-2 rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-200">Indisponível</span>
              ) : null}
              {item.supplyMode === "made_to_order" ? (
                <span className="ml-2 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-200">Por encomenda</span>
              ) : null}
              <span className={`ml-2 rounded-full border px-2 py-0.5 text-[10px] ${VISIBILITY_BADGE[item.visibility].className}`}>
                {VISIBILITY_BADGE[item.visibility].label}
              </span>
              <span className={`ml-2 rounded-full border px-2 py-0.5 text-[10px] ${item.eventId === null ? "border-(--brand-400)/40 bg-(--brand-500)/10 text-(--brand-200)" : "border-slate-700 bg-slate-900 text-slate-400"}`}>
                {item.eventLabel}
              </span>
              {isLinked ? (
                <span className="ml-2 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-200">
                  Estoque compartilhado: {item.linkedEventKitItemName ?? "item do evento"}
                </span>
              ) : null}
            </p>
            {item.description ? <p className="mt-1 text-xs text-slate-400">{item.description}</p> : null}
          </div>
        </div>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-2">
            <StoreItemForm
              events={events}
              eventId={item.eventId}
              eventLabel={item.eventLabel}
              item={{
                id: item.id,
                name: item.name,
                slug: item.slug,
                description: item.description,
                price: item.price,
                discountType: item.discountType,
                discountValue: item.discountValue,
                requiresVariant: item.requiresVariant,
                sortOrder: item.sortOrder,
                supplyMode: item.supplyMode,
                availableAllEvents: item.eventId === null,
                visibility: item.visibility,
                isActive: item.isActive,
                eventId: item.eventId,
                linkedEventKitItemId: item.linkedEventKitItemId,
              }}
            />
            {item.isActive ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => handleSetActive(false)}
                className="inline-flex h-9 items-center rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 text-xs text-amber-200 disabled:opacity-50"
              >
                Desativar
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => handleSetActive(true)}
                  className="inline-flex h-9 items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200 disabled:opacity-50"
                >
                  Reativar
                </button>
                {confirmingDelete ? (
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
                    Excluir permanentemente?
                    <button type="button" disabled={pending} onClick={handleDelete} className="rounded border border-rose-400/50 px-2 py-0.5 font-semibold disabled:opacity-50">
                      {pending ? "..." : "Sim"}
                    </button>
                    <button type="button" onClick={() => setConfirmingDelete(false)} className="rounded border border-slate-600 px-2 py-0.5 text-slate-300">
                      Cancelar
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingDelete(true)}
                    className="inline-flex h-9 items-center rounded-lg border border-rose-500/30 px-3 text-xs text-rose-300/80 hover:border-rose-500/50 hover:text-rose-200"
                  >
                    Excluir
                  </button>
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
      {statusMessage ? <p className="mt-2 text-xs text-slate-400" role="status">{statusMessage}</p> : null}

      <StoreItemImageGallery storeItemId={item.id} images={item.images} canManage={canManage} />

      {isLinked ? (
        <div className="mt-3 space-y-2 rounded-xl border border-sky-500/20 bg-sky-500/5 p-3">
          <p className="text-xs text-sky-200">
            Os tamanhos e o estoque abaixo vêm do item &quot;{item.linkedEventKitItemName ?? "vinculado"}&quot; do evento — não são gerenciados pela loja.
          </p>
          {item.variants.length === 0 ? (
            <p className="text-xs text-slate-500">Nenhum tamanho cadastrado ainda no item de kit vinculado.</p>
          ) : (
            item.variants.map((variant) => (
              <div key={variant.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-2 text-xs text-slate-300">
                {variant.name}: {variant.value} — {item.supplyMode === "made_to_order" ? "sob encomenda" : `${variant.availableQuantity} disponível(is)`}
              </div>
            ))
          )}
          {canManage ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setSyncMessage(null);
                startTransition(async () => {
                  const result = await syncLinkedStoreItemVariantsAction(item.id);
                  setSyncMessage(result.message);
                });
              }}
              className="rounded-lg border border-sky-500/40 px-2 py-1 text-[11px] text-sky-200 disabled:opacity-50"
            >
              {pending ? "Sincronizando..." : "Sincronizar tamanhos com o evento"}
            </button>
          ) : null}
          {syncMessage ? <p className="text-[11px] text-slate-400" role="status">{syncMessage}</p> : null}
        </div>
      ) : item.requiresVariant ? (
        <div className="mt-3 space-y-2">
          {item.variants.length === 0 ? (
            <p className="text-xs text-slate-500">Nenhuma variante cadastrada ainda.</p>
          ) : (
            item.variants.map((variant) => (
              <div key={variant.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-2">
                <p className="text-xs font-medium text-slate-200">
                  {variant.name}: {variant.value}
                  {variant.priceAdjustment ? <span className="ml-1 text-slate-500">({variant.priceAdjustment > 0 ? "+" : ""}{money(variant.priceAdjustment)})</span> : null}
                  {item.isActive && item.supplyMode === "stock" && variant.availableQuantity <= 0 ? (
                    <span className="ml-2 rounded-full border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-200">Indisponível</span>
                  ) : null}
                </p>
                {canManage && item.supplyMode === "stock" ? (
                  <div className="mt-1">
                    <StoreStockInput
                      storeItemId={item.id}
                      variantId={variant.id}
                      totalQuantity={variant.totalQuantity}
                      reservedQuantity={variant.reservedQuantity}
                      deliveredQuantity={variant.deliveredQuantity}
                      availableQuantity={variant.availableQuantity}
                    />
                  </div>
                ) : null}
              </div>
            ))
          )}
          {canManage ? <StoreItemVariantForm storeItemId={item.id} /> : null}
        </div>
      ) : canManage && item.supplyMode === "stock" ? (
        <div className="mt-3">
          <StoreStockInput
            storeItemId={item.id}
            variantId={null}
            totalQuantity={item.totalQuantity}
            reservedQuantity={item.reservedQuantity}
            deliveredQuantity={item.deliveredQuantity}
            availableQuantity={item.availableQuantity}
          />
        </div>
      ) : null}
    </div>
  );
}
