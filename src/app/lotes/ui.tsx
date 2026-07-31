"use client";

import { useMemo, useState, useTransition } from "react";
import { activateBatchAction, createBatchAction, deleteBatchAction, updateBatchAction } from "./actions";

type BatchRow = {
  id: string;
  event_id: string;
  name: string;
  sequence_number: number;
  male_price: number;
  female_price: number;
  max_confirmed_registrations: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  confirmed_count: number;
  remaining_slots: number;
  created_at: string;
  updated_at: string;
};

type CategoryRow = {
  id: string;
  event_id: string;
  name: string;
  slug: string;
  is_active: boolean;
  sort_order: number;
};

type BatchCategoryPriceRow = {
  batch_id: string;
  ticket_category_id: string;
  male_price: number;
  female_price: number;
};

type CategoryPriceForm = {
  ticket_category_id: string;
  enabled: boolean;
  male_price: string;
  female_price: string;
};

type PricingMode = "unisex" | "gendered";

type FormState = {
  id?: string;
  name: string;
  max_confirmed_registrations: string;
  starts_at: string;
  ends_at: string;
  is_active: boolean;
  pricing_mode: PricingMode;
  category_prices: CategoryPriceForm[];
};

function initialForm(categories: CategoryRow[]): FormState {
  const active = categories.filter((category) => category.is_active);
  const singleCategoryId = active.length === 1 ? active[0].id : null;

  return {
    name: "",
    max_confirmed_registrations: "",
    starts_at: "",
    ends_at: "",
    is_active: false,
    pricing_mode: "unisex",
    category_prices: categories.map((category) => ({
      ticket_category_id: category.id,
      enabled: singleCategoryId ? category.id === singleCategoryId : category.slug === "open-bar",
      male_price: "",
      female_price: "",
    })),
  };
}

function ordinalLabel(value: number) {
  return `${value}º`;
}

function defaultBatchName(sequenceNumber: number) {
  return `${ordinalLabel(sequenceNumber)} Lote`;
}

function toDatetimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const tzOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
}

function detectPricingMode(categoryPrices: Array<{ male_price: number; female_price: number }>): PricingMode {
  if (categoryPrices.length === 0) return "unisex";
  const hasDifference = categoryPrices.some((price) => Number(price.male_price) !== Number(price.female_price));
  return hasDifference ? "gendered" : "unisex";
}

export function BatchesManager({
  eventId,
  batches,
  categories,
  batchCategoryPrices,
}: {
  eventId: string;
  batches: BatchRow[];
  categories: CategoryRow[];
  batchCategoryPrices: BatchCategoryPriceRow[];
}) {
  const [isPending, startTransition] = useTransition();
  const [form, setForm] = useState<FormState>(initialForm(categories));
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const activeCategories = useMemo(() => categories.filter((category) => category.is_active), [categories]);
  const isSingleActiveCategory = activeCategories.length === 1;
  const nextSequenceNumber = useMemo(
    () => batches.reduce((max, batch) => Math.max(max, Number(batch.sequence_number ?? 0)), 0) + 1,
    [batches],
  );
  const defaultName = useMemo(
    () => defaultBatchName(form.id ? Number(batches.find((batch) => batch.id === form.id)?.sequence_number ?? nextSequenceNumber) : nextSequenceNumber),
    [batches, form.id, nextSequenceNumber],
  );

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function loadForEdit(batch: BatchRow) {
    const byCategory = new Map<string, BatchCategoryPriceRow>();
    for (const row of batchCategoryPrices) {
      if (row.batch_id === batch.id) {
        byCategory.set(row.ticket_category_id, row);
      }
    }

    setForm({
      id: batch.id,
      name: batch.name,
      max_confirmed_registrations: String(batch.max_confirmed_registrations),
      starts_at: toDatetimeLocal(batch.starts_at),
      ends_at: toDatetimeLocal(batch.ends_at),
      is_active: batch.is_active,
      pricing_mode: detectPricingMode(
        categories.map((category) => {
          const existing = byCategory.get(category.id);
          return {
            male_price: existing ? Number(existing.male_price) : Number(batch.male_price),
            female_price: existing ? Number(existing.female_price) : Number(batch.female_price),
          };
        }),
      ),
      category_prices: categories.map((category) => {
        const existing = byCategory.get(category.id);
        return {
          ticket_category_id: category.id,
          enabled: isSingleActiveCategory ? category.id === activeCategories[0]?.id : Boolean(existing),
          male_price: existing ? String(existing.male_price) : String(batch.male_price),
          female_price: existing ? String(existing.female_price) : String(batch.female_price),
        };
      }),
    });
  }

  function resetForm() {
    setForm(initialForm(categories));
  }

  function updateCategoryPrice(index: number, field: keyof CategoryPriceForm, value: string | boolean) {
    setForm((prev) => {
      const next = [...prev.category_prices];
      const current = next[index];
      if (!current) return prev;

      next[index] = {
        ...current,
        [field]: value,
      } as CategoryPriceForm;

      if (prev.pricing_mode === "unisex" && field === "male_price") {
        next[index].female_price = String(value);
      }

      return {
        ...prev,
        category_prices: next,
      };
    });
  }

  function updatePricingMode(mode: PricingMode) {
    setForm((prev) => {
      if (mode === prev.pricing_mode) return prev;
      const nextCategoryPrices = prev.category_prices.map((categoryPrice) => ({
        ...categoryPrice,
        female_price: mode === "unisex" ? categoryPrice.male_price : categoryPrice.female_price,
      }));
      return {
        ...prev,
        pricing_mode: mode,
        category_prices: nextCategoryPrices,
      };
    });
  }

  function runClientValidations() {
    if (!form.max_confirmed_registrations || Number(form.max_confirmed_registrations) <= 0) {
      return "Limite de confirmadas deve ser maior que zero.";
    }

    if (form.starts_at && form.ends_at && new Date(form.ends_at).getTime() < new Date(form.starts_at).getTime()) {
      return "Data final nao pode ser anterior a data inicial.";
    }

    const enabled = form.category_prices.filter((categoryPrice) => categoryPrice.enabled);
    if (enabled.length === 0) {
      return "Ative pelo menos uma categoria no lote.";
    }

    for (const categoryPrice of enabled) {
      const male = Number(categoryPrice.male_price);
      const female = form.pricing_mode === "unisex" ? male : Number(categoryPrice.female_price);
      if (Number.isNaN(male) || male < 0 || Number.isNaN(female) || female < 0) {
        return form.pricing_mode === "unisex"
          ? "Toda categoria ativa precisa de preco unissex valido."
          : "Toda categoria ativa precisa de preco masculino e feminino validos.";
      }
    }

    return null;
  }

  function submit() {
    setMessage(null);

    const validationError = runClientValidations();
    if (validationError) {
      setMessage({ type: "error", text: validationError });
      return;
    }

    startTransition(async () => {
      const payload = {
        id: form.id,
        event_id: eventId,
        name: form.name,
        max_confirmed_registrations: Number(form.max_confirmed_registrations),
        starts_at: form.starts_at || null,
        ends_at: form.ends_at || null,
        is_active: form.is_active,
        category_prices: form.category_prices.map((categoryPrice) => {
          const malePrice = Number(categoryPrice.male_price || 0);
          const femalePrice = form.pricing_mode === "unisex"
            ? malePrice
            : Number(categoryPrice.female_price || 0);
          return {
            ticket_category_id: categoryPrice.ticket_category_id,
            enabled: categoryPrice.enabled,
            male_price: malePrice,
            female_price: femalePrice,
          };
        }),
      };

      const result = form.id ? await updateBatchAction(payload) : await createBatchAction(payload);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) {
        resetForm();
      }
    });
  }

  function activate(batch: BatchRow) {
    setMessage(null);
    startTransition(async () => {
      const result = await activateBatchAction({ id: batch.id, event_id: batch.event_id });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  function remove(batch: BatchRow) {
    setMessage(null);
    startTransition(async () => {
      const result = await deleteBatchAction({ id: batch.id, event_id: batch.event_id });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-200">{form.id ? "Editar lote" : "Novo lote"}</p>

        {!form.id ? (
          <p className="mt-2 text-sm text-emerald-200">Próximo lote: {defaultBatchName(nextSequenceNumber)}</p>
        ) : (
          <p className="mt-2 text-sm text-slate-300">Sequencia deste lote: {ordinalLabel(Number(batches.find((batch) => batch.id === form.id)?.sequence_number ?? 0))}</p>
        )}

        {!form.id ? <p className="mt-1 text-xs text-slate-400">Este será o {ordinalLabel(nextSequenceNumber)} lote.</p> : null}

        {message ? (
          <div
            className={`mt-3 rounded-xl border px-3 py-2 text-sm ${
              message.type === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-red-500/30 bg-red-500/10 text-red-200"
            }`}
          >
            {message.text}
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Nome personalizado (opcional)</span>
            <input
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
              placeholder={defaultName}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Limite de confirmadas</span>
            <input
              value={form.max_confirmed_registrations}
              onChange={(e) => updateField("max_confirmed_registrations", e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Inicio</span>
            <input type="datetime-local" lang="pt-BR" placeholder="dd/MM/aaaa HH:mm" value={form.starts_at} onChange={(e) => updateField("starts_at", e.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Fim</span>
            <input type="datetime-local" lang="pt-BR" placeholder="dd/MM/aaaa HH:mm" value={form.ends_at} onChange={(e) => updateField("ends_at", e.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={form.is_active} onChange={(e) => updateField("is_active", e.target.checked)} />
          Ativar lote ao salvar
        </label>

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
          <p className="text-sm font-semibold text-slate-200">Modelo de precificacao</p>
          <div className="mt-2 flex flex-wrap gap-3 text-sm text-slate-300">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="pricing-mode"
                checked={form.pricing_mode === "unisex"}
                onChange={() => updatePricingMode("unisex")}
              />
              Unissex
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="pricing-mode"
                checked={form.pricing_mode === "gendered"}
                onChange={() => updatePricingMode("gendered")}
              />
              Masculino e Feminino
            </label>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            No modo Unissex, o mesmo valor e aplicado para todos os generos.
          </p>
        </div>

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
          {isSingleActiveCategory ? (
            <p className="text-sm font-semibold text-slate-200">Precos</p>
          ) : (
            <p className="text-sm font-semibold text-slate-200">Precos por categoria</p>
          )}
          <div className="mt-3 space-y-3">
            {activeCategories.map((category) => {
              const categoryIndex = form.category_prices.findIndex((item) => item.ticket_category_id === category.id);
              const categoryPrice = categoryIndex >= 0 ? form.category_prices[categoryIndex] : null;
              return (
                <div key={category.id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-slate-100">{category.name}</p>
                    {!isSingleActiveCategory ? (
                      <label className="flex items-center gap-2 text-xs text-slate-300">
                        <input
                          type="checkbox"
                          checked={categoryPrice?.enabled ?? false}
                          onChange={(event) => updateCategoryPrice(categoryIndex, "enabled", event.target.checked)}
                        />
                        Ativada neste lote
                      </label>
                    ) : null}
                  </div>
                  <div className={`mt-3 grid gap-3 ${form.pricing_mode === "unisex" ? "md:grid-cols-1" : "md:grid-cols-2"}`}>
                    <label className="space-y-1 text-sm">
                      <span className="text-slate-300">{form.pricing_mode === "unisex" ? "Preco unissex" : "Preco masculino"}</span>
                      <input
                        value={categoryPrice?.male_price ?? ""}
                        onChange={(event) => updateCategoryPrice(categoryIndex, "male_price", event.target.value)}
                        disabled={!isSingleActiveCategory && !(categoryPrice?.enabled ?? false)}
                        className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 disabled:opacity-60"
                      />
                    </label>

                    {form.pricing_mode === "gendered" ? (
                      <label className="space-y-1 text-sm">
                        <span className="text-slate-300">Preco feminino</span>
                        <input
                          value={categoryPrice?.female_price ?? ""}
                          onChange={(event) => updateCategoryPrice(categoryIndex, "female_price", event.target.value)}
                          disabled={!isSingleActiveCategory && !(categoryPrice?.enabled ?? false)}
                          className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 disabled:opacity-60"
                        />
                      </label>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={submit} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
            {isPending ? "Salvando..." : form.id ? "Atualizar lote" : "Criar lote"}
          </button>
          {form.id ? (
            <button type="button" onClick={resetForm} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300">
              Cancelar edicao
            </button>
          ) : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-800/80">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-950/70 text-left text-slate-400">
            <tr>
              <th className="px-4 py-3">Lote</th>
              <th className="px-4 py-3">Masculino</th>
              <th className="px-4 py-3">Feminino</th>
              <th className="px-4 py-3">Limite</th>
              <th className="px-4 py-3">Confirmadas</th>
              <th className="px-4 py-3">Restantes</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Acoes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 bg-slate-900/60 text-slate-200">
            {batches.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-400">Nenhum lote cadastrado para o evento ativo.</td>
              </tr>
            ) : (
              batches.map((batch) => (
                <tr key={batch.id}>
                  <td className="px-4 py-3">{batch.name}</td>
                  <td className="px-4 py-3">R$ {Number(batch.male_price).toFixed(2)}</td>
                  <td className="px-4 py-3">R$ {Number(batch.female_price).toFixed(2)}</td>
                  <td className="px-4 py-3">{batch.max_confirmed_registrations}</td>
                  <td className="px-4 py-3">{batch.confirmed_count}</td>
                  <td className="px-4 py-3">{batch.remaining_slots}</td>
                  <td className="px-4 py-3">{batch.is_active ? "Ativo" : "Inativo"}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => loadForEdit(batch)} className="rounded-lg border border-slate-700 px-2 py-1 text-xs">Editar</button>
                      <button type="button" onClick={() => activate(batch)} className="rounded-lg border border-slate-700 px-2 py-1 text-xs" disabled={batch.is_active}>Ativar</button>
                      <button type="button" onClick={() => remove(batch)} className="rounded-lg border border-slate-700 px-2 py-1 text-xs">Apagar</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
