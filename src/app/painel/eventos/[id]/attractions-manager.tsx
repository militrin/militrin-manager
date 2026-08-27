"use client";

import { useState, useTransition } from "react";
import { deleteEventAttractionAction, upsertEventAttractionAction } from "@/app/eventos/actions";
import { EventBannerUpload } from "./event-banner-upload";

type AttractionRow = {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  banner_url: string | null;
  is_active: boolean;
  sort_order: number;
};

const emptyForm = {
  name: "",
  description: "",
  banner_url: null as string | null,
  is_active: true,
  sort_order: "0",
};

export function AttractionsManager({
  eventId,
  attractions,
}: {
  eventId: string;
  attractions: AttractionRow[];
}) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  function resetForm() {
    setEditingId(null);
    setForm(emptyForm);
  }

  function loadForEdit(attraction: AttractionRow) {
    setEditingId(attraction.id);
    setForm({
      name: attraction.name,
      description: attraction.description ?? "",
      banner_url: attraction.banner_url,
      is_active: attraction.is_active,
      sort_order: String(attraction.sort_order),
    });
    setMessage(null);
  }

  function submit() {
    setMessage(null);
    if (!form.name.trim()) {
      setMessage({ type: "error", text: "Informe o nome da atração." });
      return;
    }

    startTransition(async () => {
      const result = await upsertEventAttractionAction({
        id: editingId ?? undefined,
        event_id: eventId,
        name: form.name,
        description: form.description || null,
        banner_url: form.banner_url,
        is_active: form.is_active,
        sort_order: Number(form.sort_order || 0),
      });

      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) resetForm();
    });
  }

  function remove(attraction: AttractionRow) {
    if (!window.confirm(`Remover a atração "${attraction.name}"?`)) return;
    setMessage(null);
    startTransition(async () => {
      const result = await deleteEventAttractionAction({ event_id: eventId, attraction_id: attraction.id });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-200">{editingId ? "Editar atração" : "Nova atração"}</p>

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
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
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

          <div className="md:col-span-2">
            <EventBannerUpload
              label="Banner da atração"
              hint="Banner exibido no card da atração."
              value={form.banner_url}
              onChange={(url) => setForm((prev) => ({ ...prev, banner_url: url }))}
              recommendedWidth={1200}
              recommendedHeight={675}
              minWidth={960}
              minHeight={540}
            />
          </div>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={form.is_active}
            onChange={(event) => setForm((prev) => ({ ...prev, is_active: event.target.checked }))}
          />
          Atração ativa (visível na página pública)
        </label>

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={submit} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
            {isPending ? "Salvando..." : editingId ? "Atualizar atração" : "Criar atração"}
          </button>
          {editingId ? (
            <button type="button" onClick={resetForm} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300">
              Cancelar edição
            </button>
          ) : null}
        </div>
      </div>

      <div className="space-y-3">
        {attractions.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
            Nenhuma atração cadastrada. Enquanto não houver nenhuma, o link &quot;Ver atrações&quot; não aparece na página pública do evento.
          </div>
        ) : (
          attractions.map((attraction) => (
            <div key={attraction.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
              <div className="flex items-center gap-3">
                {attraction.banner_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={attraction.banner_url} alt="" className="h-12 w-20 rounded-lg border border-slate-700 object-cover" />
                ) : null}
                <div>
                  <p className="text-sm font-semibold text-slate-100">{attraction.name}</p>
                  <p className="text-xs text-slate-400">{attraction.description ?? "Sem descrição"}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-3 py-1 text-xs ${attraction.is_active ? "border-emerald-500/40 text-emerald-300" : "border-slate-700 text-slate-400"}`}>
                  {attraction.is_active ? "Ativa" : "Inativa"}
                </span>
                <button type="button" onClick={() => loadForEdit(attraction)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200">Editar</button>
                <button type="button" onClick={() => remove(attraction)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200">Remover</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
