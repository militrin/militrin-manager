"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { createCouponAction, deleteOrArchiveCouponAction, getCouponDetailsAction, getCouponScopeOptionsAction, toggleCouponAction, updateCouponAction } from "./actions";
import { formatDateBR, toDatetimeLocalValue } from "@/lib/utils/date";
import { DateTimeField } from "@/components/forms/DateTimeField";
import type { CouponStatusFilter } from "./page";

type CouponRow = {
  id: string;
  code: string;
  discount_type: "percentage" | "fixed";
  discount_value: number;
  applies_to_tickets: boolean;
  applies_to_products: boolean;
  max_uses: number | null;
  used_count: number;
  valid_from: string | null;
  valid_until: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  archived_at: string | null;
  has_usage: boolean;
};

type ScopeOptions = {
  events: Array<{ id: string; name: string; year: number | null }>;
  ticket_categories: Array<{ id: string; name: string; event_id: string }>;
  store_items: Array<{ id: string; name: string; price: number; image_url: string | null; is_active: boolean }>;
};

type FormState = {
  id?: string;
  code: string;
  discount_type: "percentage" | "fixed";
  discount_value: string;
  applies_to_tickets: boolean;
  applies_to_products: boolean;
  max_uses: string;
  valid_from: string;
  valid_until: string;
  notes: string;
  is_active: boolean;
  eventScope: "all" | "specific";
  event_ids: string[];
  categoryScope: "all" | "specific";
  ticket_category_ids: string[];
  productScope: "all" | "specific";
  store_item_ids: string[];
};

function initialForm(): FormState {
  return {
    code: "", discount_type: "percentage", discount_value: "10",
    applies_to_tickets: true, applies_to_products: false,
    max_uses: "", valid_from: "", valid_until: "", notes: "", is_active: true,
    eventScope: "all", event_ids: [],
    categoryScope: "all", ticket_category_ids: [],
    productScope: "all", store_item_ids: [],
  };
}

function money(value: number) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function CouponsManager({ organizationId, coupons, status }: { organizationId: string; coupons: CouponRow[]; status: CouponStatusFilter }) {
  const [isPending, startTransition] = useTransition();
  const [form, setForm] = useState<FormState>(initialForm());
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [options, setOptions] = useState<ScopeOptions | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getCouponScopeOptionsAction(organizationId).then((result) => {
      if (!active) return;
      if (result.success) setOptions(result.options);
      setLoadingOptions(false);
    });
    return () => { active = false; };
  }, [organizationId]);

  const eventsById = useMemo(() => new Map((options?.events ?? []).map((event) => [event.id, event])), [options]);
  const categoriesByEvent = useMemo(() => {
    const map = new Map<string, Array<{ id: string; name: string }>>();
    for (const category of options?.ticket_categories ?? []) {
      const list = map.get(category.event_id) ?? [];
      list.push({ id: category.id, name: category.name });
      map.set(category.event_id, list);
    }
    return map;
  }, [options]);

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function resetForm() {
    setForm(initialForm());
  }

  function toggleInArray(key: "event_ids" | "ticket_category_ids" | "store_item_ids", id: string) {
    setForm((prev) => {
      const current = prev[key];
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
      return { ...prev, [key]: next };
    });
  }

  async function loadForEdit(coupon: CouponRow) {
    setMessage(null);
    const result = await getCouponDetailsAction(coupon.id);
    if (!result.success) {
      setMessage({ type: "error", text: result.message });
      return;
    }
    const details = result.coupon as {
      event_ids: string[]; ticket_category_ids: string[]; store_item_ids: string[];
      valid_from: string | null; valid_until: string | null; max_uses: number | null;
    };
    setForm({
      id: coupon.id,
      code: coupon.code,
      discount_type: coupon.discount_type,
      discount_value: String(coupon.discount_value),
      applies_to_tickets: coupon.applies_to_tickets,
      applies_to_products: coupon.applies_to_products,
      max_uses: details.max_uses == null ? "" : String(details.max_uses),
      valid_from: toDatetimeLocalValue(details.valid_from),
      valid_until: toDatetimeLocalValue(details.valid_until),
      notes: coupon.notes ?? "",
      is_active: coupon.is_active,
      eventScope: details.event_ids.length ? "specific" : "all",
      event_ids: details.event_ids,
      categoryScope: details.ticket_category_ids.length ? "specific" : "all",
      ticket_category_ids: details.ticket_category_ids,
      productScope: details.store_item_ids.length ? "specific" : "all",
      store_item_ids: details.store_item_ids,
    });
  }

  function submit() {
    setMessage(null);
    const payload = {
      id: form.id,
      organization_id: organizationId,
      code: form.code,
      discount_type: form.discount_type,
      discount_value: Number(form.discount_value || 0),
      applies_to_tickets: form.applies_to_tickets,
      applies_to_products: form.applies_to_products,
      max_uses: form.max_uses ? Number(form.max_uses) : null,
      valid_from: form.valid_from || null,
      valid_until: form.valid_until || null,
      notes: form.notes || null,
      is_active: form.is_active,
      event_ids: form.applies_to_tickets && form.eventScope === "specific" ? form.event_ids : [],
      ticket_category_ids: form.applies_to_tickets && form.eventScope === "specific" && form.categoryScope === "specific" ? form.ticket_category_ids : [],
      store_item_ids: form.applies_to_products && form.productScope === "specific" ? form.store_item_ids : [],
    };

    startTransition(async () => {
      const result = form.id ? await updateCouponAction(payload) : await createCouponAction(payload);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) resetForm();
    });
  }

  function toggle(coupon: CouponRow) {
    setMessage(null);
    startTransition(async () => {
      const result = await toggleCouponAction({ id: coupon.id, is_active: !coupon.is_active });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  function confirmDelete(coupon: CouponRow) {
    setMessage(null);
    startTransition(async () => {
      const result = await deleteOrArchiveCouponAction(coupon.id);
      setConfirmDeleteId(null);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success && form.id === coupon.id) resetForm();
    });
  }

  const selectedEventsForCategories = form.event_ids.filter((id) => categoriesByEvent.has(id));

  return (
    <div className="space-y-6">
      {status === "archived" ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          Cupons arquivados ficam fora da lista padrão e não podem mais ser aplicados em novas compras. O histórico de pedidos onde já foram usados permanece intacto.
        </div>
      ) : (
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-200">{form.id ? "Editar cupom" : "Novo cupom"}</p>

        {message ? (
          <div className={`mt-3 rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
            {message.text}
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Código</span>
            <input value={form.code} onChange={(e) => updateField("code", e.target.value.toUpperCase())} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" placeholder="FESTA20" />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Desconto</span>
              <input value={form.discount_value} onChange={(e) => updateField("discount_value", e.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Tipo</span>
              <select value={form.discount_type} onChange={(e) => updateField("discount_type", e.target.value as FormState["discount_type"])} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
                <option value="percentage">%</option>
                <option value="fixed">R$</option>
              </select>
            </label>
          </div>
        </div>

        <div className="mt-4">
          <span className="text-sm text-slate-300">Aplicar em</span>
          <div className="mt-1 flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" checked={form.applies_to_tickets} onChange={(e) => updateField("applies_to_tickets", e.target.checked)} />
              Ingressos
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-200">
              <input type="checkbox" checked={form.applies_to_products} onChange={(e) => updateField("applies_to_products", e.target.checked)} />
              Produtos da loja
            </label>
          </div>
        </div>

        {form.applies_to_tickets ? (
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Ingressos</p>
            <div className="mt-2 space-y-2 text-sm">
              <p className="text-slate-300">Quais?</p>
              <label className="flex items-center gap-2"><input type="radio" name="eventScope" checked={form.eventScope === "all"} onChange={() => updateField("eventScope", "all")} /> Todos os eventos</label>
              <label className="flex items-center gap-2"><input type="radio" name="eventScope" checked={form.eventScope === "specific"} onChange={() => updateField("eventScope", "specific")} /> Eventos específicos</label>
            </div>
            {form.eventScope === "specific" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {loadingOptions ? <span className="text-xs text-slate-500">Carregando eventos...</span> : null}
                {(options?.events ?? []).map((event) => {
                  const selected = form.event_ids.includes(event.id);
                  return (
                    <button key={event.id} type="button" onClick={() => toggleInArray("event_ids", event.id)}
                      className={`rounded-full border px-3 py-1 text-xs ${selected ? "border-emerald-500 bg-emerald-500/10 text-emerald-200" : "border-slate-700 text-slate-300"}`}>
                      {event.name}{event.year ? ` (${event.year})` : ""}{selected ? " ×" : ""}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {form.eventScope === "specific" && form.event_ids.length > 0 ? (
              <div className="mt-3">
                <p className="text-slate-300 text-sm">Categorias</p>
                <label className="mt-1 flex items-center gap-2 text-sm"><input type="radio" name="categoryScope" checked={form.categoryScope === "all"} onChange={() => updateField("categoryScope", "all")} /> Todas as categorias dos eventos selecionados</label>
                <label className="flex items-center gap-2 text-sm"><input type="radio" name="categoryScope" checked={form.categoryScope === "specific"} onChange={() => updateField("categoryScope", "specific")} /> Categorias específicas</label>
                {form.categoryScope === "specific" ? (
                  <div className="mt-2 space-y-2">
                    {selectedEventsForCategories.map((eventId) => (
                      <div key={eventId}>
                        <p className="text-xs text-slate-400">{eventsById.get(eventId)?.name ?? eventId}</p>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {(categoriesByEvent.get(eventId) ?? []).map((category) => {
                            const selected = form.ticket_category_ids.includes(category.id);
                            return (
                              <button key={category.id} type="button" onClick={() => toggleInArray("ticket_category_ids", category.id)}
                                className={`rounded-full border px-3 py-1 text-xs ${selected ? "border-emerald-500 bg-emerald-500/10 text-emerald-200" : "border-slate-700 text-slate-300"}`}>
                                {category.name}{selected ? " ×" : ""}
                              </button>
                            );
                          })}
                          {(categoriesByEvent.get(eventId) ?? []).length === 0 ? <span className="text-xs text-slate-500">Sem categorias configuradas.</span> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {form.applies_to_products ? (
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Produtos</p>
            <div className="mt-2 space-y-2 text-sm">
              <p className="text-slate-300">Quais?</p>
              <label className="flex items-center gap-2"><input type="radio" name="productScope" checked={form.productScope === "all"} onChange={() => updateField("productScope", "all")} /> Todos</label>
              <label className="flex items-center gap-2"><input type="radio" name="productScope" checked={form.productScope === "specific"} onChange={() => updateField("productScope", "specific")} /> Produtos específicos</label>
            </div>
            {form.productScope === "specific" ? (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {loadingOptions ? <span className="text-xs text-slate-500">Carregando produtos...</span> : null}
                {(options?.store_items ?? []).map((item) => {
                  const selected = form.store_item_ids.includes(item.id);
                  return (
                    <button key={item.id} type="button" onClick={() => toggleInArray("store_item_ids", item.id)}
                      className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-xs ${selected ? "border-emerald-500 bg-emerald-500/10 text-emerald-200" : "border-slate-700 text-slate-300"}`}>
                      {item.image_url ? <img src={item.image_url} alt="" className="h-8 w-8 rounded object-cover" /> : null}
                      <span className="flex-1">
                        <span className="block font-medium">{item.name}{!item.is_active ? " (inativo)" : ""}</span>
                        <span className="block text-slate-400">{money(Number(item.price))}</span>
                      </span>
                      {selected ? "×" : ""}
                    </button>
                  );
                })}
                {options && options.store_items.length === 0 ? <span className="text-xs text-slate-500">Nenhum produto cadastrado nesta organização.</span> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Limite de usos</span>
            <input value={form.max_uses} onChange={(e) => updateField("max_uses", e.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" placeholder="Ilimitado" />
          </label>
          <div />
          <DateTimeField label="Início" value={form.valid_from} onChange={(next) => updateField("valid_from", next)} />
          <DateTimeField label="Fim" value={form.valid_until} onChange={(next) => updateField("valid_until", next)} />
        </div>

        <label className="mt-3 block space-y-1 text-sm">
          <span className="text-slate-300">Observação</span>
          <input value={form.notes} onChange={(e) => updateField("notes", e.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
        </label>

        <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={form.is_active} onChange={(e) => updateField("is_active", e.target.checked)} />
          Ativo
        </label>

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={submit} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
            {isPending ? "Salvando..." : form.id ? "Atualizar" : "Criar cupom"}
          </button>
          {form.id ? (
            <button type="button" onClick={resetForm} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300">Cancelar edição</button>
          ) : null}
        </div>
      </div>
      )}

      <div className="overflow-x-auto rounded-2xl border border-slate-800/80">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-950/70 text-left text-slate-400">
            <tr>
              <th className="px-4 py-3">Código</th>
              <th className="px-4 py-3">Desconto</th>
              <th className="px-4 py-3">Aplica em</th>
              <th className="px-4 py-3">Usos</th>
              <th className="px-4 py-3">Validade</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 bg-slate-900/60 text-slate-200">
            {coupons.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-slate-400">Nenhum cupom criado para esta organização.</td></tr>
            ) : (
              coupons.map((coupon) => {
                const archived = coupon.archived_at !== null;
                return (
                <tr key={coupon.id}>
                  <td className="px-4 py-3 font-semibold">{coupon.code}</td>
                  <td className="px-4 py-3">{coupon.discount_type === "percentage" ? `${Number(coupon.discount_value).toFixed(0)}%` : money(Number(coupon.discount_value))}</td>
                  <td className="px-4 py-3">{[coupon.applies_to_tickets ? "Ingressos" : null, coupon.applies_to_products ? "Produtos" : null].filter(Boolean).join(" + ")}</td>
                  <td className="px-4 py-3">{coupon.used_count}{coupon.max_uses ? ` / ${coupon.max_uses}` : " (sem limite)"}</td>
                  <td className="px-4 py-3">{coupon.valid_from ? formatDateBR(coupon.valid_from) : "-"} {" -> "} {coupon.valid_until ? formatDateBR(coupon.valid_until) : "-"}</td>
                  <td className="px-4 py-3">
                    {archived ? (
                      <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-200">
                        Arquivado{coupon.archived_at ? ` em ${formatDateBR(coupon.archived_at)}` : ""}
                      </span>
                    ) : coupon.is_active ? "Ativo" : "Inativo"}
                  </td>
                  <td className="px-4 py-3">
                    {confirmDeleteId === coupon.id ? (
                      <div className="space-y-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-100">
                        <p>
                          {coupon.has_usage
                            ? "Arquivar cupom — já possui utilizações. Ele será removido da lista padrão e não poderá mais ser aplicado em novas compras; o histórico de pedidos não é alterado."
                            : "Excluir cupom definitivamente. Esta ação não pode ser desfeita."}
                        </p>
                        <div className="flex gap-2">
                          <button type="button" onClick={() => confirmDelete(coupon)} disabled={isPending} className="rounded-lg bg-rose-500 px-2 py-1 font-semibold text-rose-950 disabled:opacity-60">
                            {isPending ? "Aguarde..." : coupon.has_usage ? "Confirmar arquivamento" : "Confirmar exclusão"}
                          </button>
                          <button type="button" onClick={() => setConfirmDeleteId(null)} disabled={isPending} className="rounded-lg border border-rose-500/40 px-2 py-1 text-rose-200">Cancelar</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {!archived ? (
                          <>
                            <button type="button" onClick={() => void loadForEdit(coupon)} className="rounded-lg border border-slate-700 px-2 py-1 text-xs">Editar</button>
                            <button type="button" onClick={() => toggle(coupon)} className="rounded-lg border border-slate-700 px-2 py-1 text-xs">{coupon.is_active ? "Desativar" : "Ativar"}</button>
                            <button type="button" onClick={() => setConfirmDeleteId(coupon.id)} className="rounded-lg border border-rose-500/40 px-2 py-1 text-xs text-rose-300">Excluir</button>
                          </>
                        ) : null}
                        <button type="button" onClick={() => void navigator.clipboard.writeText(coupon.code)} className="rounded-lg border border-slate-700 px-2 py-1 text-xs">Copiar código</button>
                      </div>
                    )}
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
