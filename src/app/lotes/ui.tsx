"use client";

import { useMemo, useState, useTransition } from "react";
import { activateBatchAction, createBatchAction, deleteBatchAction, updateBatchAction } from "./actions";
import { DateTimeField } from "@/components/forms/DateTimeField";
import { SlideOverPanel } from "@/components/admin/SlideOverPanel";

type BatchCategoryRow = {
  id: string;
  event_id: string;
  name: string;
  sequence_number: number;
  ticket_category_id: string;
  category_name: string;
  male_price: number;
  female_price: number;
  max_confirmed_registrations: number | null;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  confirmed_count: number;
  remaining_slots: number | null;
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

type CategoryPriceForm = {
  ticket_category_id: string;
  enabled: boolean;
  male_price: string;
  female_price: string;
  max_confirmed_registrations: string;
};

type PricingMode = "unisex" | "gendered";

type FormState = {
  id?: string;
  name: string;
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
    starts_at: "",
    ends_at: "",
    is_active: false,
    pricing_mode: "unisex",
    category_prices: categories.map((category) => ({
      ticket_category_id: category.id,
      enabled: singleCategoryId ? category.id === singleCategoryId : category.slug === "open-bar",
      male_price: "",
      female_price: "",
      max_confirmed_registrations: "",
    })),
  };
}

function ordinalLabel(value: number) {
  return `${value}º`;
}

function defaultBatchName(sequenceNumber: number) {
  return `${ordinalLabel(sequenceNumber)} Lote`;
}

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
}

function priceLabel(malePrice: number, femalePrice: number) {
  return malePrice === femalePrice ? money(malePrice) : `${money(malePrice)} masc. / ${money(femalePrice)} fem.`;
}

function periodLabel(startsAt: string | null, endsAt: string | null) {
  const format = (value: string) => new Date(value).toLocaleDateString("pt-BR");
  if (startsAt && endsAt) return `${format(startsAt)} até ${format(endsAt)}`;
  if (endsAt) return `até ${format(endsAt)}`;
  if (startsAt) return `a partir de ${format(startsAt)}`;
  return "Sem período definido";
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

type DistinctBatch = {
  id: string;
  event_id: string;
  name: string;
  sequence_number: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
};

export function BatchesManager({
  eventId,
  batches,
  categories,
  categoriesNeedingPrice = [],
}: {
  eventId: string;
  batches: BatchCategoryRow[];
  categories: CategoryRow[];
  categoriesNeedingPrice?: { id: string; name: string }[];
}) {
  const [isPending, startTransition] = useTransition();
  const [form, setForm] = useState<FormState>(initialForm(categories));
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  const activeCategories = useMemo(() => categories.filter((category) => category.is_active), [categories]);
  const isSingleActiveCategory = activeCategories.length === 1;

  const distinctBatches = useMemo(() => {
    const map = new Map<string, DistinctBatch>();
    for (const row of batches) {
      if (!map.has(row.id)) {
        map.set(row.id, {
          id: row.id,
          event_id: row.event_id,
          name: row.name,
          sequence_number: row.sequence_number,
          starts_at: row.starts_at,
          ends_at: row.ends_at,
          is_active: row.is_active,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.sequence_number - b.sequence_number);
  }, [batches]);

  const nextSequenceNumber = useMemo(
    () => distinctBatches.reduce((max, batch) => Math.max(max, Number(batch.sequence_number ?? 0)), 0) + 1,
    [distinctBatches],
  );
  const defaultName = useMemo(
    () => defaultBatchName(form.id ? Number(distinctBatches.find((batch) => batch.id === form.id)?.sequence_number ?? nextSequenceNumber) : nextSequenceNumber),
    [distinctBatches, form.id, nextSequenceNumber],
  );

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function openCreate() {
    setForm(initialForm(categories));
    setPanelOpen(true);
  }

  function openEdit(batch: DistinctBatch) {
    const byCategory = new Map<string, BatchCategoryRow>();
    for (const row of batches) {
      if (row.id === batch.id) {
        byCategory.set(row.ticket_category_id, row);
      }
    }

    setForm({
      id: batch.id,
      name: batch.name,
      starts_at: toDatetimeLocal(batch.starts_at),
      ends_at: toDatetimeLocal(batch.ends_at),
      is_active: batch.is_active,
      pricing_mode: detectPricingMode(
        categories.map((category) => {
          const existing = byCategory.get(category.id);
          return {
            male_price: existing ? Number(existing.male_price) : 0,
            female_price: existing ? Number(existing.female_price) : 0,
          };
        }),
      ),
      category_prices: categories.map((category) => {
        const existing = byCategory.get(category.id);
        return {
          ticket_category_id: category.id,
          enabled: isSingleActiveCategory ? category.id === activeCategories[0]?.id : Boolean(existing),
          male_price: existing ? String(existing.male_price) : "",
          female_price: existing ? String(existing.female_price) : "",
          max_confirmed_registrations: existing?.max_confirmed_registrations != null ? String(existing.max_confirmed_registrations) : "",
        };
      }),
    });
    setPanelOpen(true);
  }

  function closePanel() {
    setPanelOpen(false);
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
    if (form.starts_at && form.ends_at && new Date(form.ends_at).getTime() < new Date(form.starts_at).getTime()) {
      return "Data final nao pode ser anterior a data inicial.";
    }

    const enabled = form.category_prices.filter((categoryPrice) => categoryPrice.enabled);
    if (enabled.length === 0) {
      return "Ative pelo menos uma categoria no lote.";
    }

    const hasEndsAt = Boolean(form.ends_at);

    for (const categoryPrice of enabled) {
      const male = Number(categoryPrice.male_price);
      const female = form.pricing_mode === "unisex" ? male : Number(categoryPrice.female_price);
      if (Number.isNaN(male) || male < 0 || Number.isNaN(female) || female < 0) {
        return form.pricing_mode === "unisex"
          ? "Toda categoria ativa precisa de preco unissex valido."
          : "Toda categoria ativa precisa de preco masculino e feminino validos.";
      }
      const limitRaw = categoryPrice.max_confirmed_registrations.trim();
      if (limitRaw && (!Number.isInteger(Number(limitRaw)) || Number(limitRaw) <= 0)) {
        return "O limite de confirmadas, quando preenchido, deve ser um numero inteiro maior que zero.";
      }
      if (!limitRaw && !hasEndsAt) {
        return "Toda categoria ativa precisa de um limite de confirmadas, de uma data de encerramento do lote, ou dos dois.";
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
        starts_at: form.starts_at || null,
        ends_at: form.ends_at || null,
        is_active: form.is_active,
        category_prices: form.category_prices.map((categoryPrice) => {
          const malePrice = Number(categoryPrice.male_price || 0);
          const femalePrice = form.pricing_mode === "unisex"
            ? malePrice
            : Number(categoryPrice.female_price || 0);
          const limitRaw = categoryPrice.max_confirmed_registrations.trim();
          return {
            ticket_category_id: categoryPrice.ticket_category_id,
            enabled: categoryPrice.enabled,
            male_price: malePrice,
            female_price: femalePrice,
            max_confirmed_registrations: limitRaw ? Number(limitRaw) : null,
          };
        }),
      };

      const result = form.id ? await updateBatchAction(payload) : await createBatchAction(payload);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) {
        setPanelOpen(false);
      }
    });
  }

  function activate(batch: DistinctBatch) {
    setMessage(null);
    startTransition(async () => {
      const result = await activateBatchAction({ id: batch.id, event_id: batch.event_id });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  function remove(batch: DistinctBatch) {
    setMessage(null);
    startTransition(async () => {
      const result = await deleteBatchAction({ id: batch.id, event_id: batch.event_id });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-400">{distinctBatches.length === 0 ? "Nenhum lote cadastrado." : `${distinctBatches.length} lote(s) cadastrado(s).`}</p>
        <button type="button" onClick={openCreate} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950">
          + Novo lote
        </button>
      </div>

      {message ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
          {message.text}
        </div>
      ) : null}

      {categoriesNeedingPrice.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-100">
          <p>
            {categoriesNeedingPrice.length === 1
              ? `A categoria ${categoriesNeedingPrice[0].name} está ativa, mas ainda não possui lote/preço configurado.`
              : `As categorias ${categoriesNeedingPrice.map((category) => category.name).join(", ")} estão ativas, mas ainda não possuem lote/preço configurado.`}
          </p>
          <button type="button" onClick={openCreate} className="shrink-0 rounded-lg border border-amber-400/50 bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/30">
            {categoriesNeedingPrice.length === 1 ? `Configurar lote da ${categoriesNeedingPrice[0].name}` : "Configurar lote"}
          </button>
        </div>
      ) : null}

      <div className="space-y-2">
        {distinctBatches.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/40 p-6 text-center text-sm text-slate-400">
            Nenhum lote cadastrado para este evento.
          </div>
        ) : (
          distinctBatches.map((batch) => {
            const rows = batches.filter((row) => row.id === batch.id);
            return (
              <div key={batch.id} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold ${batch.is_active ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800/80 text-slate-500"}`}>
                      {ordinalLabel(batch.sequence_number)}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-slate-100">{batch.name}</p>
                        <span className={`rounded-full border px-2.5 py-0.5 text-[11px] ${batch.is_active ? "border-emerald-500/40 text-emerald-300" : "border-slate-700 text-slate-400"}`}>
                          {batch.is_active ? "Ativo" : "Inativo"}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-slate-400">{periodLabel(batch.starts_at, batch.ends_at)}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => openEdit(batch)} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500">Editar</button>
                    <button type="button" onClick={() => activate(batch)} disabled={batch.is_active} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500 disabled:opacity-40">Ativar</button>
                    <button type="button" onClick={() => remove(batch)} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:border-rose-500/50 hover:text-rose-300">Apagar</button>
                  </div>
                </div>

                <div className="mt-3 space-y-1.5">
                  {rows.map((row) => (
                    <div key={`${row.id}-${row.ticket_category_id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2.5 text-xs">
                      {!isSingleActiveCategory ? <span className="font-medium text-slate-200">{row.category_name}</span> : <span className="text-slate-400">Preço</span>}
                      <span className="font-semibold text-emerald-300">{priceLabel(Number(row.male_price), Number(row.female_price))}</span>
                      <span className="h-3.5 w-px shrink-0 bg-slate-700" aria-hidden />
                      <span className="text-slate-400">{row.confirmed_count} confirmadas</span>
                      <span className="h-3.5 w-px shrink-0 bg-slate-700" aria-hidden />
                      <span className="text-slate-400">{row.remaining_slots ?? "sem limite"} restantes</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      <SlideOverPanel open={panelOpen} onClose={closePanel} title={form.id ? "Editar lote" : "Novo lote"}>
        <div className="space-y-4">
          {!form.id ? (
            <p className="text-sm text-emerald-200">Próximo lote: {defaultBatchName(nextSequenceNumber)}</p>
          ) : (
            <p className="text-sm text-slate-300">Sequência deste lote: {ordinalLabel(Number(distinctBatches.find((b) => b.id === form.id)?.sequence_number ?? 0))}</p>
          )}

          <div className="grid gap-3">
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Nome personalizado (opcional)</span>
              <input
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder={defaultName}
                className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
                autoFocus
              />
            </label>

            <DateTimeField label="Início" value={form.starts_at} onChange={(next) => updateField("starts_at", next)} />
            <DateTimeField label="Fim" value={form.ends_at} onChange={(next) => updateField("ends_at", next)} />
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={form.is_active} onChange={(e) => updateField("is_active", e.target.checked)} />
            Ativar lote ao salvar
          </label>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <p className="text-sm font-semibold text-slate-200">Modelo de precificação</p>
            <div className="mt-2 flex flex-wrap gap-3 text-sm text-slate-300">
              <label className="flex items-center gap-2">
                <input type="radio" name="pricing-mode" checked={form.pricing_mode === "unisex"} onChange={() => updatePricingMode("unisex")} />
                Unissex
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="pricing-mode" checked={form.pricing_mode === "gendered"} onChange={() => updatePricingMode("gendered")} />
                Masculino e Feminino
              </label>
            </div>
            <p className="mt-2 text-xs text-slate-400">No modo Unissex, o mesmo valor é aplicado para todos os gêneros.</p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <p className="text-sm font-semibold text-slate-200">{isSingleActiveCategory ? "Preços e limite de confirmadas" : "Preços e limite de confirmadas por categoria"}</p>
            <div className="mt-3 space-y-3">
              {activeCategories.map((category) => {
                const categoryIndex = form.category_prices.findIndex((item) => item.ticket_category_id === category.id);
                const categoryPrice = categoryIndex >= 0 ? form.category_prices[categoryIndex] : null;
                const disabled = !isSingleActiveCategory && !(categoryPrice?.enabled ?? false);
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
                    <div className={`mt-3 grid gap-3 ${form.pricing_mode === "unisex" ? "md:grid-cols-2" : "md:grid-cols-3"}`}>
                      <label className="space-y-1 text-sm">
                        <span className="text-slate-300">{form.pricing_mode === "unisex" ? "Preço unissex" : "Preço masculino"}</span>
                        <input
                          value={categoryPrice?.male_price ?? ""}
                          onChange={(event) => updateCategoryPrice(categoryIndex, "male_price", event.target.value)}
                          disabled={disabled}
                          className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 disabled:opacity-60"
                        />
                      </label>

                      {form.pricing_mode === "gendered" ? (
                        <label className="space-y-1 text-sm">
                          <span className="text-slate-300">Preço feminino</span>
                          <input
                            value={categoryPrice?.female_price ?? ""}
                            onChange={(event) => updateCategoryPrice(categoryIndex, "female_price", event.target.value)}
                            disabled={disabled}
                            className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 disabled:opacity-60"
                          />
                        </label>
                      ) : null}

                      <label className="space-y-1 text-sm">
                        <span className="text-slate-300">Limite de confirmadas</span>
                        <input
                          value={categoryPrice?.max_confirmed_registrations ?? ""}
                          onChange={(event) => updateCategoryPrice(categoryIndex, "max_confirmed_registrations", event.target.value)}
                          disabled={disabled}
                          placeholder="Vazio = sem limite por quantidade"
                          className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 disabled:opacity-60"
                        />
                        <span className="block text-xs text-slate-500">Opcional se o lote tiver data de encerramento (Fim). Pelo menos um dos dois precisa estar preenchido.</span>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex gap-2">
            <button type="button" onClick={submit} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
              {isPending ? "Salvando..." : form.id ? "Atualizar lote" : "Criar lote"}
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
