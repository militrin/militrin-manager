"use client";

import { useMemo, useState, useTransition } from "react";
import {
  deleteKitItemAction,
  deleteKitVariantAction,
  upsertKitItemAction,
  upsertKitVariantAction,
} from "../actions";

type EventSummary = {
  id: string;
  name: string;
  slug: string;
  year: number | null;
  kit_enabled: boolean;
  registration_enabled: boolean;
  is_active: boolean;
};

type VariantRow = {
  id: string;
  name: string;
  value: string;
  sort_order: number;
  is_active: boolean;
};

type KitItemRow = {
  id: string;
  event_id: string;
  name: string;
  slug: string;
  description: string | null;
  item_type: string;
  quantity_per_participant: number;
  requires_variant: boolean;
  is_required: boolean;
  is_active: boolean;
  sort_order: number;
  variants: VariantRow[];
};

const itemTypes = [
  { value: "shirt", label: "Camiseta" },
  { value: "cup", label: "Copo" },
  { value: "strap", label: "Tirante" },
  { value: "cup_holder", label: "Porta-copo" },
  { value: "wristband", label: "Pulseira" },
  { value: "badge", label: "Crachá" },
  { value: "voucher", label: "Voucher" },
  { value: "other", label: "Outro" },
];

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function EventKitManager({ event, items }: { event: EventSummary; items: KitItemRow[] }) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    slug: "",
    description: "",
    item_type: "other",
    quantity_per_participant: "1",
    requires_variant: false,
    is_required: true,
    is_active: true,
    sort_order: "0",
  });
  const [variantDrafts, setVariantDrafts] = useState<Record<string, { name: string; value: string; sort_order: string; is_active: boolean }>>({});

  const sortedItems = useMemo(() => [...items].sort((a, b) => a.sort_order - b.sort_order), [items]);

  function resetForm() {
    setEditingItemId(null);
    setForm({
      name: "",
      slug: "",
      description: "",
      item_type: "other",
      quantity_per_participant: "1",
      requires_variant: false,
      is_required: true,
      is_active: true,
      sort_order: "0",
    });
  }

  function loadForEdit(item: KitItemRow) {
    setEditingItemId(item.id);
    setForm({
      name: item.name,
      slug: item.slug,
      description: item.description ?? "",
      item_type: item.item_type,
      quantity_per_participant: String(item.quantity_per_participant),
      requires_variant: item.requires_variant,
      is_required: item.is_required,
      is_active: item.is_active,
      sort_order: String(item.sort_order),
    });
  }

  function saveItem() {
    setMessage(null);
    startTransition(async () => {
      const result = await upsertKitItemAction({
        id: editingItemId ?? undefined,
        event_id: event.id,
        name: form.name,
        slug: form.slug || slugify(form.name),
        description: form.description || null,
        item_type: form.item_type as "shirt" | "cup" | "strap" | "cup_holder" | "wristband" | "badge" | "voucher" | "other",
        quantity_per_participant: Number(form.quantity_per_participant || 1),
        requires_variant: form.requires_variant,
        is_required: form.is_required,
        is_active: form.is_active,
        sort_order: Number(form.sort_order || 0),
      });

      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) resetForm();
    });
  }

  function deleteItem(item: KitItemRow) {
    setMessage(null);
    startTransition(async () => {
      const result = await deleteKitItemAction({ event_id: item.event_id, kit_item_id: item.id });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  function saveVariant(itemId: string) {
    const draft = variantDrafts[itemId] ?? { name: "", value: "", sort_order: "0", is_active: true };
    setMessage(null);
    startTransition(async () => {
      const result = await upsertKitVariantAction({
        kit_item_id: itemId,
        name: draft.name,
        value: draft.value,
        sort_order: Number(draft.sort_order || 0),
        is_active: draft.is_active,
      });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) {
        setVariantDrafts((prev) => ({ ...prev, [itemId]: { name: "", value: "", sort_order: "0", is_active: true } }));
      }
    });
  }

  function removeVariant(id: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await deleteKitVariantAction(id);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-200">{editingItemId ? "Editar item" : "Novo item de kit"}</p>

        {message ? (
          <div className={`mt-3 rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
            {message.text}
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Nome</span>
            <input value={form.name} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value, slug: prev.slug || slugify(event.target.value) }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Slug</span>
            <input value={form.slug} onChange={(event) => setForm((prev) => ({ ...prev, slug: slugify(event.target.value) }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Tipo</span>
            <select value={form.item_type} onChange={(event) => setForm((prev) => ({ ...prev, item_type: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
              {itemTypes.map((itemType) => <option key={itemType.value} value={itemType.value}>{itemType.label}</option>)}
            </select>
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Quantidade por participante</span>
            <input value={form.quantity_per_participant} onChange={(event) => setForm((prev) => ({ ...prev, quantity_per_participant: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Ordem</span>
            <input value={form.sort_order} onChange={(event) => setForm((prev) => ({ ...prev, sort_order: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm md:col-span-2">
            <span className="text-slate-300">Descrição</span>
            <textarea value={form.description} onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} rows={2} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-3 text-sm text-slate-300">
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.requires_variant} onChange={(event) => setForm((prev) => ({ ...prev, requires_variant: event.target.checked }))} /> Este item possui tamanhos/opções?</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.is_required} onChange={(event) => setForm((prev) => ({ ...prev, is_required: event.target.checked }))} /> Obrigatório</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.is_active} onChange={(event) => setForm((prev) => ({ ...prev, is_active: event.target.checked }))} /> Ativo</label>
        </div>

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={saveItem} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">{isPending ? "Salvando..." : editingItemId ? "Atualizar item" : "Adicionar item"}</button>
          {editingItemId ? <button type="button" onClick={resetForm} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300">Cancelar</button> : null}
        </div>
      </div>

      <div className="space-y-4">
        {sortedItems.length === 0 ? <p className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-400">Nenhum item cadastrado.</p> : sortedItems.map((item) => {
          const draft = variantDrafts[item.id] ?? { name: "", value: "", sort_order: "0", is_active: true };
          return (
            <div key={item.id} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-slate-100">{item.name}</p>
                  <p className="text-xs text-slate-400">{item.item_type} · slug: {item.slug}</p>
                </div>
                <div className="flex gap-2 text-xs">
                  <span className={`rounded-full border px-3 py-1 ${item.is_active ? "border-emerald-500/40 text-emerald-300" : "border-slate-700 text-slate-400"}`}>{item.is_active ? "Ativo" : "Inativo"}</span>
                  <span className={`rounded-full border px-3 py-1 ${item.is_required ? "border-amber-500/40 text-amber-300" : "border-slate-700 text-slate-400"}`}>{item.is_required ? "Obrigatório" : "Opcional"}</span>
                  <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-300">Qtd: {item.quantity_per_participant}</span>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => loadForEdit(item)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200">Editar</button>
                <button type="button" onClick={() => deleteItem(item)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200">Excluir</button>
              </div>

              {item.requires_variant ? <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <p className="text-xs font-semibold text-slate-300">Tamanhos/opções</p>
                <div className="mt-2 space-y-2">
                  {item.variants.length === 0 ? <p className="text-xs text-slate-500">Sem variações.</p> : item.variants.map((variant) => (
                    <div key={variant.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-1.5 text-xs text-slate-300">
                      <p>{variant.name}: {variant.value}</p>
                      <button type="button" onClick={() => removeVariant(variant.id)} className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300">Remover</button>
                    </div>
                  ))}
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-4">
                  <input value={draft.name} onChange={(event) => setVariantDrafts((prev) => ({ ...prev, [item.id]: { ...draft, name: event.target.value } }))} placeholder="Opção (ex.: 500 ml)" className="rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-xs" />
                  <input value={draft.value} onChange={(event) => setVariantDrafts((prev) => ({ ...prev, [item.id]: { ...draft, value: event.target.value } }))} placeholder="Valor" className="rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-xs" />
                  <input value={draft.sort_order} onChange={(event) => setVariantDrafts((prev) => ({ ...prev, [item.id]: { ...draft, sort_order: event.target.value } }))} placeholder="Ordem" className="rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-xs" />
                  <button type="button" onClick={() => saveVariant(item.id)} className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-emerald-950">Adicionar opção</button>
                </div>
              </div> : <p className="mt-4 text-xs text-slate-500">Opção única · nenhuma variante artificial será criada.</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
