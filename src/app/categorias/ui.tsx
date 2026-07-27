"use client";

import { useMemo, useState, useTransition } from "react";
import {
  createBenefitAction,
  createCategoryAction,
  deleteBenefitAction,
  toggleCategoryActiveAction,
  updateCategoryAction,
} from "./actions";

type CategoryRow = {
  id: string;
  event_id: string;
  name: string;
  slug: string;
  description: string | null;
  capacity: number | null;
  is_active: boolean;
  sort_order: number;
  confirmed_count: number;
  pending_count: number;
  reserved_count: number;
  available_slots: number | null;
};

type BenefitRow = {
  id: string;
  ticket_category_id: string;
  name: string;
  description: string | null;
  sort_order: number;
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function CategoriesManager({
  eventId,
  categories,
  benefits,
}: {
  eventId: string;
  categories: CategoryRow[];
  benefits: BenefitRow[];
}) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    slug: "",
    description: "",
    capacity: "",
    is_active: true,
    sort_order: "0",
  });
  const [benefitDraft, setBenefitDraft] = useState<Record<string, { name: string; description: string; sort_order: string }>>({});

  const benefitsByCategory = useMemo(() => {
    const map = new Map<string, BenefitRow[]>();
    for (const benefit of benefits) {
      const list = map.get(benefit.ticket_category_id) ?? [];
      list.push(benefit);
      map.set(benefit.ticket_category_id, list);
    }
    return map;
  }, [benefits]);

  function resetForm() {
    setEditingId(null);
    setForm({ name: "", slug: "", description: "", capacity: "", is_active: true, sort_order: "0" });
  }

  function loadForEdit(category: CategoryRow) {
    setEditingId(category.id);
    setForm({
      name: category.name,
      slug: category.slug,
      description: category.description ?? "",
      capacity: category.capacity === null ? "" : String(category.capacity),
      is_active: category.is_active,
      sort_order: String(category.sort_order),
    });
  }

  function submit() {
    setMessage(null);
    startTransition(async () => {
      const payload = {
        id: editingId ?? undefined,
        event_id: eventId,
        name: form.name,
        slug: form.slug || slugify(form.name),
        description: form.description || null,
        capacity: form.capacity ? Number(form.capacity) : null,
        is_active: form.is_active,
        sort_order: Number(form.sort_order || 0),
      };

      const result = editingId ? await updateCategoryAction(payload) : await createCategoryAction(payload);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) resetForm();
    });
  }

  function toggleActive(category: CategoryRow) {
    setMessage(null);
    startTransition(async () => {
      const result = await toggleCategoryActiveAction({
        id: category.id,
        event_id: category.event_id,
        is_active: !category.is_active,
      });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  function addBenefit(categoryId: string) {
    const draft = benefitDraft[categoryId] ?? { name: "", description: "", sort_order: "0" };
    setMessage(null);

    startTransition(async () => {
      const result = await createBenefitAction({
        ticket_category_id: categoryId,
        name: draft.name,
        description: draft.description || null,
        sort_order: Number(draft.sort_order || 0),
      });

      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) {
        setBenefitDraft((prev) => ({ ...prev, [categoryId]: { name: "", description: "", sort_order: "0" } }));
      }
    });
  }

  function removeBenefit(benefitId: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await deleteBenefitAction({ id: benefitId });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-200">{editingId ? "Editar categoria" : "Nova categoria"}</p>

        {message ? (
          <div className={`mt-3 rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
            {message.text}
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Nome</span>
            <input
              value={form.name}
              onChange={(event) => {
                const name = event.target.value;
                setForm((prev) => ({ ...prev, name, slug: prev.slug || slugify(name) }));
              }}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Slug</span>
            <input
              value={form.slug}
              onChange={(event) => setForm((prev) => ({ ...prev, slug: slugify(event.target.value) }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Capacidade</span>
            <input
              value={form.capacity}
              onChange={(event) => setForm((prev) => ({ ...prev, capacity: event.target.value }))}
              placeholder="Vazio = sem limite"
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Ordem</span>
            <input
              value={form.sort_order}
              onChange={(event) => setForm((prev) => ({ ...prev, sort_order: event.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>

          <label className="space-y-1 text-sm md:col-span-2">
            <span className="text-slate-300">Descrição</span>
            <textarea
              value={form.description}
              onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
              rows={3}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(event) => setForm((prev) => ({ ...prev, is_active: event.target.checked }))}
          />
          Categoria ativa
        </label>

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={submit} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
            {isPending ? "Salvando..." : editingId ? "Atualizar categoria" : "Criar categoria"}
          </button>
          {editingId ? (
            <button type="button" onClick={resetForm} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300">
              Cancelar edição
            </button>
          ) : null}
        </div>
      </div>

      <div className="space-y-4">
        {categories.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">Nenhuma categoria cadastrada.</div>
        ) : categories.map((category) => {
          const draft = benefitDraft[category.id] ?? { name: "", description: "", sort_order: "0" };
          const list = benefitsByCategory.get(category.id) ?? [];

          return (
            <div key={category.id} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-base font-semibold text-slate-100">{category.name}</p>
                  <p className="text-xs text-slate-400">slug: {category.slug}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">Confirmados: {category.confirmed_count}</span>
                  <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">Pendentes: {category.pending_count}</span>
                  <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">Vagas: {category.available_slots === null ? "∞" : category.available_slots}</span>
                  <span className={`rounded-full border px-3 py-1 text-xs ${category.is_active ? "border-emerald-500/40 text-emerald-300" : "border-slate-700 text-slate-400"}`}>
                    {category.is_active ? "Ativa" : "Inativa"}
                  </span>
                </div>
              </div>

              <p className="mt-2 text-sm text-slate-300">{category.description ?? "Sem descrição"}</p>

              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => loadForEdit(category)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200">Editar</button>
                <button type="button" onClick={() => toggleActive(category)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200">
                  {category.is_active ? "Desativar" : "Ativar"}
                </button>
              </div>

              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <p className="text-xs font-semibold text-slate-300">Benefícios</p>
                <div className="mt-2 space-y-2">
                  {list.length === 0 ? <p className="text-xs text-slate-500">Nenhum benefício cadastrado.</p> : list.map((benefit) => (
                    <div key={benefit.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-2 py-1.5 text-xs text-slate-300">
                      <div>
                        <p className="font-medium text-slate-200">{benefit.name}</p>
                        <p>{benefit.description ?? "Sem descrição"}</p>
                      </div>
                      <button type="button" onClick={() => removeBenefit(benefit.id)} className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300">Remover</button>
                    </div>
                  ))}
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-4">
                  <input
                    value={draft.name}
                    onChange={(event) => setBenefitDraft((prev) => ({ ...prev, [category.id]: { ...draft, name: event.target.value } }))}
                    placeholder="Novo benefício"
                    className="rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-xs md:col-span-2"
                  />
                  <input
                    value={draft.description}
                    onChange={(event) => setBenefitDraft((prev) => ({ ...prev, [category.id]: { ...draft, description: event.target.value } }))}
                    placeholder="Descrição"
                    className="rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-xs"
                  />
                  <div className="flex gap-2">
                    <input
                      value={draft.sort_order}
                      onChange={(event) => setBenefitDraft((prev) => ({ ...prev, [category.id]: { ...draft, sort_order: event.target.value } }))}
                      placeholder="Ordem"
                      className="w-20 rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-xs"
                    />
                    <button type="button" onClick={() => addBenefit(category.id)} className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-emerald-950">
                      Adicionar
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
