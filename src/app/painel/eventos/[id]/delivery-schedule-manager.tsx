"use client";

import { useState, useTransition } from "react";
import { deleteKitDeliveryScheduleAction, upsertKitDeliveryScheduleAction } from "@/app/eventos/actions";
import { formatDateBR, toDatetimeLocalValue } from "@/lib/utils/date";

type KitDeliveryRow = {
  id: string;
  delivery_at: string;
  city: string;
  location: string;
  sort_order: number;
  is_active: boolean;
};

type DeliveryScheduleManagerProps = {
  initialRows: KitDeliveryRow[];
};

function toDatetimeLocal(value: string | null) {
  return toDatetimeLocalValue(value);
}

export function DeliveryScheduleManager({ initialRows }: DeliveryScheduleManagerProps) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [rows, setRows] = useState<KitDeliveryRow[]>(initialRows);
  const [form, setForm] = useState({
    id: "",
    delivery_at: "",
    city: "",
    location: "",
    sort_order: "0",
    is_active: true,
  });

  function resetForm() {
    setForm({ id: "", delivery_at: "", city: "", location: "", sort_order: "0", is_active: true });
  }

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await upsertKitDeliveryScheduleAction({
        id: form.id || undefined,
        delivery_at: form.delivery_at,
        city: form.city,
        location: form.location,
        sort_order: Number(form.sort_order || 0),
        is_active: form.is_active,
      });

      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (!result.success) return;

      const nextRow: KitDeliveryRow = {
        id: form.id || crypto.randomUUID(),
        delivery_at: new Date(form.delivery_at).toISOString(),
        city: form.city,
        location: form.location,
        sort_order: Number(form.sort_order || 0),
        is_active: form.is_active,
      };

      setRows((prev) => {
        const exists = prev.some((item) => item.id === form.id);
        const merged = exists
          ? prev.map((item) => (item.id === form.id ? nextRow : item))
          : [...prev, nextRow];

        return [...merged].sort((a, b) => {
          if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
          return new Date(a.delivery_at).getTime() - new Date(b.delivery_at).getTime();
        });
      });

      resetForm();
    });
  }

  function edit(item: KitDeliveryRow) {
    setForm({
      id: item.id,
      delivery_at: toDatetimeLocal(item.delivery_at),
      city: item.city,
      location: item.location,
      sort_order: String(item.sort_order),
      is_active: item.is_active,
    });
  }

  function remove(id: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await deleteKitDeliveryScheduleAction(id);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (!result.success) return;
      setRows((prev) => prev.filter((item) => item.id !== id));
      if (form.id === id) resetForm();
    });
  }

  return (
    <div className="space-y-4">
      {message ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
          {message.text}
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-200">Cronograma de Entregas</p>
        <p className="mt-1 text-xs text-slate-400">Configure dia, hora, cidade e local das proximas entregas.</p>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Dia e hora</span>
            <input
              type="datetime-local"
              value={form.delivery_at}
              onChange={(event) => setForm((prev) => ({ ...prev, delivery_at: event.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Cidade</span>
            <input
              value={form.city}
              onChange={(event) => setForm((prev) => ({ ...prev, city: event.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Local</span>
            <input
              value={form.location}
              onChange={(event) => setForm((prev) => ({ ...prev, location: event.target.value }))}
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
        </div>

        <label className="mt-3 inline-flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(event) => setForm((prev) => ({ ...prev, is_active: event.target.checked }))}
          />
          Entrega ativa
        </label>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={save} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
            {form.id ? "Atualizar entrega" : "Adicionar entrega"}
          </button>
          {form.id ? (
            <button type="button" onClick={resetForm} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300">
              Cancelar edicao
            </button>
          ) : null}
        </div>

        <div className="mt-4 space-y-2">
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400">Nenhuma entrega de kits configurada.</p>
          ) : (
            rows.map((item) => (
              <div key={item.id} className="rounded-xl border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-200">
                <p className="font-semibold text-white">{formatDateBR(item.delivery_at)} as {toDatetimeLocal(item.delivery_at).slice(11, 16)}</p>
                <p>{item.city} - {item.location}</p>
                <p className="text-xs text-slate-400">Ordem: {item.sort_order} - {item.is_active ? "Ativa" : "Inativa"}</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => edit(item)} className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200">Editar</button>
                  <button type="button" onClick={() => remove(item.id)} className="rounded-lg border border-rose-700 px-3 py-1 text-xs text-rose-200">Remover</button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
