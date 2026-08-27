"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createEventAction, updateEventAction } from "@/app/eventos/actions";
import { DateTimeField } from "@/components/forms/DateTimeField";
import { toDatetimeLocalValue } from "@/lib/utils/date";
import { EventBannerUpload } from "./event-banner-upload";

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export type EventDataFormEvent = {
  id: string;
  name: string;
  slug: string;
  year: number | null;
  description: string | null;
  starts_at: string | null;
  ends_at: string | null;
  registration_open_at: string | null;
  registration_close_at: string | null;
  location: string | null;
  is_active: boolean;
  registration_enabled: boolean;
  kit_enabled: boolean;
  min_age: number;
  banner_hero_url: string | null;
  banner_card_url: string | null;
};

export function EventDataForm({
  mode,
  event,
}: {
  mode: "create" | "edit";
  event?: EventDataFormEvent;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [form, setForm] = useState({
    name: event?.name ?? "",
    year: event?.year !== null && event?.year !== undefined ? String(event.year) : "",
    description: event?.description ?? "",
    starts_at: toDatetimeLocalValue(event?.starts_at ?? null),
    ends_at: toDatetimeLocalValue(event?.ends_at ?? null),
    registration_open_at: toDatetimeLocalValue(event?.registration_open_at ?? null),
    registration_close_at: toDatetimeLocalValue(event?.registration_close_at ?? null),
    location: event?.location ?? "",
    kit_enabled: event?.kit_enabled ?? false,
    min_age: String(event?.min_age ?? 18),
    banner_hero_url: event?.banner_hero_url ?? null,
    banner_card_url: event?.banner_card_url ?? null,
  });

  const previewSlug = slugify(form.name) || "seu-evento";

  function submit() {
    setMessage(null);

    if (!form.name.trim()) {
      setMessage({ type: "error", text: "Informe o nome do evento." });
      return;
    }

    if (form.starts_at && form.ends_at && new Date(form.ends_at).getTime() < new Date(form.starts_at).getTime()) {
      setMessage({ type: "error", text: "A data/hora de fim não pode ser anterior ao início do evento." });
      return;
    }

    if (
      form.registration_open_at &&
      form.registration_close_at &&
      new Date(form.registration_close_at).getTime() < new Date(form.registration_open_at).getTime()
    ) {
      setMessage({ type: "error", text: "O encerramento das inscrições não pode ser anterior à abertura." });
      return;
    }

    if (Number(form.min_age) < 0 || Number.isNaN(Number(form.min_age))) {
      setMessage({ type: "error", text: "Informe uma idade mínima válida." });
      return;
    }

    startTransition(async () => {
      const payload = {
        id: mode === "edit" ? event?.id : undefined,
        name: form.name,
        slug: previewSlug,
        year: form.year ? Number(form.year) : null,
        description: form.description || null,
        starts_at: form.starts_at || null,
        ends_at: form.ends_at || null,
        registration_open_at: form.registration_open_at || null,
        registration_close_at: form.registration_close_at || null,
        location: form.location || null,
        is_active: mode === "edit" ? Boolean(event?.is_active) : false,
        registration_enabled: mode === "edit" ? Boolean(event?.registration_enabled) : false,
        kit_enabled: form.kit_enabled,
        min_age: Number(form.min_age) || 0,
        banner_hero_url: form.banner_hero_url,
        banner_card_url: form.banner_card_url,
      };

      const result = mode === "edit" ? await updateEventAction(payload) : await createEventAction(payload);
      if (!result.success) {
        setMessage({ type: "error", text: result.message });
        return;
      }

      const eventId = mode === "edit" ? event?.id ?? null : ("eventId" in result ? result.eventId : null);
      if (eventId) {
        router.push(`/painel/eventos/${eventId}?etapa=2`);
        return;
      }

      setMessage({ type: "success", text: result.message });
    });
  }

  return (
    <div className="space-y-4">
      {message ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
          {message.text}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Nome</span>
          <input value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          <span className="block text-xs text-slate-500">Endereço público: /eventos/{previewSlug} (gerado automaticamente pelo sistema).</span>
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Ano</span>
          <input value={form.year} onChange={(e) => setForm((prev) => ({ ...prev, year: e.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Local</span>
          <input value={form.location} onChange={(e) => setForm((prev) => ({ ...prev, location: e.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
        </label>

        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Idade mínima</span>
          <input
            type="number"
            min="0"
            value={form.min_age}
            onChange={(e) => setForm((prev) => ({ ...prev, min_age: e.target.value }))}
            className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
          />
          <span className="block text-xs text-slate-500">0 = sem restrição de idade.</span>
        </label>

        <label className="space-y-1 text-sm md:col-span-2">
          <span className="text-slate-300">Descrição</span>
          <textarea value={form.description} onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))} rows={3} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
        </label>

        <DateTimeField label="Início" value={form.starts_at} onChange={(next) => setForm((prev) => ({ ...prev, starts_at: next }))} />
        <DateTimeField label="Fim" value={form.ends_at} onChange={(next) => setForm((prev) => ({ ...prev, ends_at: next }))} />
        <DateTimeField label="Abertura das vendas" value={form.registration_open_at} onChange={(next) => setForm((prev) => ({ ...prev, registration_open_at: next }))} />
        <DateTimeField label="Encerramento das vendas" value={form.registration_close_at} onChange={(next) => setForm((prev) => ({ ...prev, registration_close_at: next }))} />
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={form.kit_enabled} onChange={(e) => setForm((prev) => ({ ...prev, kit_enabled: e.target.checked }))} /> Possui kit
      </label>

      <div className="grid gap-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4 md:grid-cols-2">
        <EventBannerUpload
          label="Banner de capa"
          hint="Usado no topo da página pública do evento e da inscrição."
          value={form.banner_hero_url}
          onChange={(url) => setForm((prev) => ({ ...prev, banner_hero_url: url }))}
        />
        <EventBannerUpload
          label="Banner do card (listagem, Minha Conta)"
          hint="Usado como miniatura em listagens e na Minha Conta — pode ser a mesma arte do banner de capa."
          value={form.banner_card_url}
          onChange={(url) => setForm((prev) => ({ ...prev, banner_card_url: url }))}
        />
      </div>

      {mode === "edit" ? (
        <p className="text-xs text-slate-500">Para ativar/desativar o evento ou abrir/fechar vendas, use os botões na listagem de eventos.</p>
      ) : null}

      <div className="flex gap-2">
        <button type="button" onClick={submit} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
          {isPending ? "Salvando..." : mode === "create" ? "Salvar e Criar evento" : "Salvar e ir para próxima etapa"}
        </button>
      </div>
    </div>
  );
}
