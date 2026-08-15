"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { CheckCircle2, MoreVertical, Tag } from "lucide-react";
import { SlideOverPanel } from "@/components/admin/SlideOverPanel";
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

const CATEGORY_DESCRIPTION_SUGGESTIONS: Array<{ name: string; description: string }> = [
  {
    name: "Pista",
    description: "Acesso à área principal do evento com estrutura padrão e experiência geral da festa.",
  },
  {
    name: "VIP",
    description: "Acesso à área VIP com localização privilegiada e benefícios exclusivos definidos pela organização.",
  },
  {
    name: "Camarote",
    description: "Acesso ao camarote com vista diferenciada, ambiente reservado e serviços especiais conforme o evento.",
  },
  {
    name: "Open Bar",
    description: "Acesso com serviço de open bar durante o período estipulado, conforme regras e itens disponíveis no evento.",
  },
];

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function normalizeName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
    .trim();
}

function findSuggestedDescription(categoryName: string) {
  const normalized = normalizeName(categoryName);
  return CATEGORY_DESCRIPTION_SUGGESTIONS.find((item) => normalizeName(item.name) === normalized) ?? null;
}

const emptyForm = { name: "", slug: "", description: "", is_active: true, sort_order: "0" };

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
  const [panelOpen, setPanelOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [benefitDraft, setBenefitDraft] = useState<Record<string, { name: string; description: string; sort_order: string }>>({});
  const [benefitFormOpenFor, setBenefitFormOpenFor] = useState<string | null>(null);
  const [menuOpenFor, setMenuOpenFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpenFor) return;
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpenFor(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpenFor]);

  const benefitsByCategory = useMemo(() => {
    const map = new Map<string, BenefitRow[]>();
    for (const benefit of benefits) {
      const list = map.get(benefit.ticket_category_id) ?? [];
      list.push(benefit);
      map.set(benefit.ticket_category_id, list);
    }
    return map;
  }, [benefits]);

  const suggestedDescription = useMemo(() => findSuggestedDescription(form.name), [form.name]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm);
    setPanelOpen(true);
  }

  function openEdit(category: CategoryRow) {
    setEditingId(category.id);
    setForm({
      name: category.name,
      slug: category.slug,
      description: category.description ?? "",
      is_active: category.is_active,
      sort_order: String(category.sort_order),
    });
    setPanelOpen(true);
  }

  function closePanel() {
    setPanelOpen(false);
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
        is_active: form.is_active,
        sort_order: Number(form.sort_order || 0),
      };

      const result = editingId ? await updateCategoryAction(payload) : await createCategoryAction(payload);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) {
        setPanelOpen(false);
        setForm(emptyForm);
        setEditingId(null);
      }
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
        setBenefitFormOpenFor(null);
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
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-400">{categories.length === 0 ? "Nenhuma categoria cadastrada." : `${categories.length} categoria(s) cadastrada(s).`}</p>
        <button type="button" onClick={openCreate} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950">
          + Nova categoria
        </button>
      </div>

      {message ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
          {message.text}
        </div>
      ) : null}

      <div className="space-y-3">
        {categories.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/40 p-6 text-center text-sm text-slate-400">
            Nenhuma categoria cadastrada. Eventos sem categoria operam como <strong>Ingresso único</strong>.
          </div>
        ) : categories.map((category) => {
          const list = benefitsByCategory.get(category.id) ?? [];
          const draft = benefitDraft[category.id] ?? { name: "", description: "", sort_order: "0" };
          const benefitFormOpen = benefitFormOpenFor === category.id;

          return (
            <div key={category.id} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${category.is_active ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800/80 text-slate-500"}`}>
                    <Tag size={18} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-semibold text-slate-100">{category.name}</p>
                      <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] ${category.is_active ? "border-emerald-500/40 text-emerald-300" : "border-slate-700 text-slate-400"}`}>
                        {category.is_active ? "Ativa" : "Inativa"}
                      </span>
                    </div>
                    {category.description ? <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{category.description}</p> : null}
                  </div>
                </div>

                <div className="relative shrink-0" ref={menuOpenFor === category.id ? menuRef : undefined}>
                  <button
                    type="button"
                    onClick={() => setMenuOpenFor((prev) => (prev === category.id ? null : category.id))}
                    className="rounded-lg border border-slate-700 p-1.5 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                    aria-label={`Mais ações para ${category.name}`}
                  >
                    <MoreVertical size={15} />
                  </button>
                  {menuOpenFor === category.id ? (
                    <div className="absolute right-0 z-10 mt-1 w-40 rounded-xl border border-slate-700 bg-slate-900 p-1 shadow-xl">
                      <button
                        type="button"
                        onClick={() => { toggleActive(category); setMenuOpenFor(null); }}
                        className="block w-full rounded-lg px-3 py-1.5 text-left text-xs text-slate-200 hover:bg-slate-800"
                      >
                        {category.is_active ? "Desativar" : "Ativar"}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2">
                {[
                  { label: "Confirmados", value: category.confirmed_count },
                  { label: "Pendentes", value: category.pending_count },
                  { label: "Vagas restantes", value: category.available_slots === null ? "∞" : category.available_slots },
                ].map((metric) => (
                  <div key={metric.label} className="rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">{metric.label}</p>
                    <p className="mt-0.5 text-sm font-semibold text-slate-100">{metric.value}</p>
                  </div>
                ))}
              </div>

              {list.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {list.map((benefit) => (
                    <span key={benefit.id} className="group inline-flex items-center gap-1 rounded-full border border-slate-800 bg-slate-900/60 px-2.5 py-1 text-[11px] text-slate-300">
                      <CheckCircle2 size={11} className="text-emerald-400" />
                      {benefit.name}
                      <button type="button" onClick={() => removeBenefit(benefit.id)} className="text-slate-500 hover:text-rose-300" aria-label={`Remover benefício ${benefit.name}`}>
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              {benefitFormOpen ? (
                <div className="mt-3 grid gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-2.5 md:grid-cols-4">
                  <input
                    value={draft.name}
                    onChange={(event) => setBenefitDraft((prev) => ({ ...prev, [category.id]: { ...draft, name: event.target.value } }))}
                    placeholder="Novo benefício"
                    className="rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-xs md:col-span-2"
                  />
                  <input
                    value={draft.description}
                    onChange={(event) => setBenefitDraft((prev) => ({ ...prev, [category.id]: { ...draft, description: event.target.value } }))}
                    placeholder="Descrição (opcional)"
                    className="rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-xs"
                  />
                  <div className="flex gap-2">
                    <button type="button" onClick={() => addBenefit(category.id)} className="flex-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-emerald-950">
                      Adicionar
                    </button>
                    <button type="button" onClick={() => setBenefitFormOpenFor(null)} className="rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-300">
                      ✕
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => openEdit(category)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:border-slate-500">Editar</button>
                {!benefitFormOpen ? (
                  <button type="button" onClick={() => setBenefitFormOpenFor(category.id)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:border-slate-500">
                    Benefícios
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      <SlideOverPanel open={panelOpen} onClose={closePanel} title={editingId ? "Editar categoria" : "Nova categoria"}>
        <div className="space-y-3">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Nome</span>
            <input
              value={form.name}
              onChange={(event) => {
                const name = event.target.value;
                setForm((prev) => ({ ...prev, name, slug: prev.slug || slugify(name) }));
              }}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
              autoFocus
            />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Ordem de exibição</span>
            <input
              type="number"
              value={form.sort_order}
              onChange={(event) => setForm((prev) => ({ ...prev, sort_order: event.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
            <span className="block text-xs text-slate-500">Define a posição na lista: 1 aparece primeiro, 2 aparece em segundo, e assim por diante.</span>
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Descrição</span>
            <textarea
              value={form.description}
              onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
              rows={3}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
            {suggestedDescription ? (
              <button
                type="button"
                onClick={() => setForm((prev) => ({ ...prev, description: suggestedDescription.description }))}
                className="mt-2 rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200"
              >
                Usar descrição sugerida para {suggestedDescription.name}
              </button>
            ) : null}
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(event) => setForm((prev) => ({ ...prev, is_active: event.target.checked }))}
            />
            Categoria ativa
          </label>

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={submit} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
              {isPending ? "Salvando..." : editingId ? "Atualizar categoria" : "Criar categoria"}
            </button>
            <button type="button" onClick={closePanel} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300">
              Cancelar
            </button>
          </div>
        </div>
      </SlideOverPanel>
    </div>
  );
}
