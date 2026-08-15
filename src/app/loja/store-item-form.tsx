"use client";

import { useState, useTransition } from "react";
import { upsertStoreItemAction } from "./actions";
import { StoreImageUpload } from "./store-image-upload";

type StoreItemInput = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  price: number;
  requiresVariant: boolean;
  sortOrder: number;
  supplyMode: "stock" | "made_to_order";
  availableAllEvents: boolean;
};

function slugify(value: string) {
  const base = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "item";
}

const fieldLabelClass = "mb-1 block text-xs font-medium text-slate-400";

export function StoreItemForm({ eventId, eventLabel, item }: { eventId: string; eventLabel: string; item: StoreItemInput | null }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [imageUrl, setImageUrl] = useState<string | null>(item?.imageUrl ?? null);
  const [price, setPrice] = useState(String(item?.price ?? "0"));
  const [requiresVariant, setRequiresVariant] = useState(item?.requiresVariant ?? false);
  const [supplyMode, setSupplyMode] = useState<"stock" | "made_to_order">(item?.supplyMode ?? "stock");
  const [availableAllEvents, setAvailableAllEvents] = useState(item?.availableAllEvents ?? false);
  const [message, setMessage] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200"
      >
        {item ? "Editar item" : "Novo item"}
      </button>
    );
  }

  return (
    <form
      className="grid gap-3 rounded-xl border border-slate-700 bg-slate-950/60 p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await upsertStoreItemAction({
            id: item?.id ?? null,
            eventId,
            name,
            slug: `${slugify(name)}-${(item?.id ?? crypto.randomUUID()).slice(0, 8)}`,
            description,
            imageUrl,
            price: Number(price) || 0,
            requiresVariant,
            isActive: true,
            sortOrder: item?.sortOrder ?? 0,
            supplyMode,
            availableAllEvents,
          });
          setMessage(result.message);
          if (result.success && !item) {
            setName(""); setDescription(""); setImageUrl(null); setPrice("0"); setRequiresVariant(false); setSupplyMode("stock"); setAvailableAllEvents(false); setOpen(false);
          }
        });
      }}
    >
      <div className="sm:col-span-2">
        <span className={fieldLabelClass}>Foto do item</span>
        <StoreImageUpload value={imageUrl} onChange={setImageUrl} />
      </div>
      <div>
        <label className={fieldLabelClass} htmlFor="store-item-name">Nome do item</label>
        <input
          id="store-item-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Squeeze Militrin"
          required
          className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
        />
      </div>
      <div>
        <label className={fieldLabelClass} htmlFor="store-item-price">Preço (R$)</label>
        <input
          id="store-item-price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          type="number" min="0" step="0.01"
          required
          className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
        />
      </div>
      <div className="sm:col-span-2">
        <label className={fieldLabelClass} htmlFor="store-item-description">Descrição (opcional)</label>
        <textarea
          id="store-item-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="O que é, como funciona, o que vem incluso..."
          className="h-16 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-slate-300 sm:col-span-2">
        <input type="checkbox" checked={requiresVariant} onChange={(e) => setRequiresVariant(e.target.checked)} />
        Este item tem opções (ex.: tamanho, cor) que o comprador precisa escolher
      </label>
      <div className="sm:col-span-2">
        <span className={fieldLabelClass}>Disponibilidade de estoque</span>
        <div className="flex flex-col gap-1.5 text-xs text-slate-300">
          <label className="flex items-center gap-2">
            <input type="radio" checked={supplyMode === "stock"} onChange={() => setSupplyMode("stock")} />
            Estoque limitado — eu informo a quantidade disponível
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={supplyMode === "made_to_order"} onChange={() => setSupplyMode("made_to_order")} />
            Por encomenda — sem limite, produzido depois da compra
          </label>
        </div>
      </div>
      <div className="sm:col-span-2">
        <span className={fieldLabelClass}>Oferecer em quais eventos</span>
        <div className="flex flex-col gap-1.5 text-xs text-slate-300">
          <label className="flex items-center gap-2">
            <input type="radio" checked={!availableAllEvents} onChange={() => setAvailableAllEvents(false)} />
            Somente em {eventLabel}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={availableAllEvents} onChange={() => setAvailableAllEvents(true)} />
            Em todos os eventos da organização
          </label>
        </div>
      </div>
      <div className="flex items-center gap-2 sm:col-span-2">
        <button type="submit" disabled={pending} className="inline-flex h-9 items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200 disabled:opacity-50">
          {pending ? "Salvando..." : "Salvar item"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="inline-flex h-9 items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-300">
          Cancelar
        </button>
        {message ? <span className="text-xs text-slate-400" role="status">{message}</span> : null}
      </div>
    </form>
  );
}
