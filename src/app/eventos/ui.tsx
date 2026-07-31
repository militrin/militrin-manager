"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import {
  activateEventAction,
  archiveEventAction,
  createEventAction,
  deactivateEventAction,
  duplicateEventAction,
  removeEventHighlightAction,
  setEventHighlightAction,
  setEventRegistrationEnabledAction,
  updateEventAction,
} from "./actions";
import { formatDateBR, toDatetimeLocalValue } from "@/lib/utils/date";

type EventRow = {
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
  registration_enabled: boolean;
  kit_enabled: boolean;
  is_active: boolean;
  participants_count: number;
  created_at: string;
  updated_at: string;
};

type HighlightRow = {
  event_id: string;
  sort_order: number;
  is_active: boolean;
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function toDatetimeLocal(value: string | null) {
  return toDatetimeLocalValue(value);
}

export function EventsManager({
  events,
  activeEvent,
  highlights,
}: {
  events: EventRow[];
  activeEvent: { id: string; name: string } | null;
  highlights: HighlightRow[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const eventFormRef = useRef<HTMLDivElement | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [duplicateSourceId, setDuplicateSourceId] = useState<string>(events[0]?.id ?? "");
  const [form, setForm] = useState({
    name: "",
    slug: "",
    year: "",
    description: "",
    starts_at: "",
    ends_at: "",
    registration_open_at: "",
    registration_close_at: "",
    location: "",
    is_active: false,
    registration_enabled: false,
    kit_enabled: false,
  });
  const [duplicateForm, setDuplicateForm] = useState({
    target_name: "",
    target_slug: "",
    target_year: "",
    copy_categories: true,
    copy_kit_items: true,
    copy_benefits: true,
    copy_batches: true,
    copy_batch_prices: true,
    copy_inventory_structure: true,
    copy_coupons: false,
  });
  const [highlightDraft, setHighlightDraft] = useState<Record<string, { enabled: boolean; sort_order: string }>>(() => {
    const map: Record<string, { enabled: boolean; sort_order: string }> = {};
    for (const event of events) {
      const existing = highlights.find((highlight) => highlight.event_id === event.id);
      map[event.id] = {
        enabled: Boolean(existing?.is_active),
        sort_order: String(existing?.sort_order ?? 0),
      };
    }
    return map;
  });
  const [setupEventId, setSetupEventId] = useState<string | null>(null);

  const eventCountLabel = useMemo(() => {
    if (events.length === 1) return "1 evento cadastrado";
    return `${events.length} eventos cadastrados`;
  }, [events.length]);

  function resetForm() {
    setEditingId(null);
    setForm({
      name: "",
      slug: "",
      year: "",
      description: "",
      starts_at: "",
      ends_at: "",
      registration_open_at: "",
      registration_close_at: "",
      location: "",
      is_active: false,
      registration_enabled: false,
      kit_enabled: false,
    });
  }

  function loadForEdit(item: EventRow) {
    setEditingId(item.id);
    setForm({
      name: item.name,
      slug: item.slug,
      year: item.year === null ? "" : String(item.year),
      description: item.description ?? "",
      starts_at: toDatetimeLocal(item.starts_at),
      ends_at: toDatetimeLocal(item.ends_at),
      registration_open_at: toDatetimeLocal(item.registration_open_at),
      registration_close_at: toDatetimeLocal(item.registration_close_at),
      location: item.location ?? "",
      is_active: item.is_active,
      registration_enabled: item.registration_enabled,
      kit_enabled: item.kit_enabled,
    });

    setMessage({ type: "success", text: `Evento ${item.name} carregado para edição.` });
    eventFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function submitForm() {
    setMessage(null);
    setSetupEventId(null);

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

    startTransition(async () => {
      const payload = {
        id: editingId ?? undefined,
        name: form.name,
        slug: form.slug || slugify(form.name),
        year: form.year ? Number(form.year) : null,
        description: form.description || null,
        starts_at: form.starts_at || null,
        ends_at: form.ends_at || null,
        registration_open_at: form.registration_open_at || null,
        registration_close_at: form.registration_close_at || null,
        location: form.location || null,
        is_active: form.is_active,
        registration_enabled: form.registration_enabled,
        kit_enabled: form.kit_enabled,
      };

      const result = editingId ? await updateEventAction(payload) : await createEventAction(payload);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) {
        if (!editingId && "eventId" in result && result.eventId) {
          setSetupEventId(String(result.eventId));
          router.push(`/painel/eventos/${String(result.eventId)}?etapa=2`);
        }
        resetForm();
      }
    });
  }

  function activate(item: EventRow) {
    setMessage(null);
    startTransition(async () => {
      const result = item.is_active
        ? await deactivateEventAction(item.id)
        : await activateEventAction(item.id);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  function toggleRegistration(item: EventRow) {
    setMessage(null);
    startTransition(async () => {
      const result = await setEventRegistrationEnabledAction(item.id, !item.registration_enabled);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  function archive(item: EventRow) {
    setMessage(null);
    startTransition(async () => {
      const result = await archiveEventAction(item.id);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  function duplicate() {
    if (!duplicateSourceId) return;
    setMessage(null);
    startTransition(async () => {
      const result = await duplicateEventAction({
        source_event_id: duplicateSourceId,
        target_name: duplicateForm.target_name,
        target_slug: duplicateForm.target_slug || slugify(duplicateForm.target_name),
        target_year: duplicateForm.target_year ? Number(duplicateForm.target_year) : null,
        copy_categories: duplicateForm.copy_categories,
        copy_kit_items: duplicateForm.copy_kit_items,
        copy_benefits: duplicateForm.copy_benefits,
        copy_batches: duplicateForm.copy_batches,
        copy_batch_prices: duplicateForm.copy_batch_prices,
        copy_inventory_structure: duplicateForm.copy_inventory_structure,
        copy_coupons: duplicateForm.copy_coupons,
      });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) {
        setDuplicateForm((prev) => ({ ...prev, target_name: "", target_slug: "", target_year: "" }));
      }
    });
  }

  function saveHighlight(eventId: string) {
    const draft = highlightDraft[eventId] ?? { enabled: false, sort_order: "0" };
    setMessage(null);

    startTransition(async () => {
      if (!draft.enabled) {
        const result = await removeEventHighlightAction(eventId);
        setMessage({ type: result.success ? "success" : "error", text: result.message });
        return;
      }

      const result = await setEventHighlightAction({
        event_id: eventId,
        sort_order: Number(draft.sort_order || 0),
        is_active: true,
      });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  return (
    <div className="space-y-6">
      <div ref={eventFormRef} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm text-slate-400">{eventCountLabel}</p>
        <p className="text-sm text-slate-400">Evento ativo: <span className="text-slate-200">{activeEvent?.name ?? "Nenhum"}</span></p>
        <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-200">
          Fluxo sugerido: 1) dados do evento, 2) categorias e lotes, 3) adicionais (kit, copo personalizado e brindes).
        </div>

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
            <span className="text-slate-300">Ano</span>
            <input value={form.year} onChange={(event) => setForm((prev) => ({ ...prev, year: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Local</span>
            <input value={form.location} onChange={(event) => setForm((prev) => ({ ...prev, location: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm md:col-span-2">
            <span className="text-slate-300">Descrição</span>
            <textarea value={form.description} onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} rows={3} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Início</span>
            <input type="datetime-local" lang="pt-BR" placeholder="dd/MM/aaaa HH:mm" value={form.starts_at} onChange={(event) => setForm((prev) => ({ ...prev, starts_at: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Fim</span>
            <input type="datetime-local" lang="pt-BR" placeholder="dd/MM/aaaa HH:mm" value={form.ends_at} onChange={(event) => setForm((prev) => ({ ...prev, ends_at: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Abertura das inscrições</span>
            <input type="datetime-local" lang="pt-BR" placeholder="dd/MM/aaaa HH:mm" value={form.registration_open_at} onChange={(event) => setForm((prev) => ({ ...prev, registration_open_at: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Encerramento das inscrições</span>
            <input type="datetime-local" lang="pt-BR" placeholder="dd/MM/aaaa HH:mm" value={form.registration_close_at} onChange={(event) => setForm((prev) => ({ ...prev, registration_close_at: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-3 text-sm text-slate-300">
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.is_active} onChange={(event) => setForm((prev) => ({ ...prev, is_active: event.target.checked }))} /> Evento ativo</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.registration_enabled} onChange={(event) => setForm((prev) => ({ ...prev, registration_enabled: event.target.checked }))} /> Inscrições habilitadas</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.kit_enabled} onChange={(event) => setForm((prev) => ({ ...prev, kit_enabled: event.target.checked }))} /> Possui kit</label>
        </div>

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={submitForm} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
            {isPending ? "Salvando..." : editingId ? "Atualizar evento" : "Criar evento"}
          </button>
          {editingId ? <button type="button" onClick={resetForm} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300">Cancelar</button> : null}
        </div>

        {setupEventId ? (
          <div className="mt-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-3 text-sm text-cyan-100">
            <p className="font-semibold">Evento criado. Continue o passo a passo:</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Link href={`/painel/eventos/${setupEventId}`} className="rounded-lg border border-cyan-400/40 px-3 py-1.5 text-xs text-cyan-100">
                Etapa 2: categorias e lotes
              </Link>
              <Link href={`/painel/eventos/${setupEventId}`} className="rounded-lg border border-cyan-400/40 px-3 py-1.5 text-xs text-cyan-100">
                Etapa 3: adicionais
              </Link>
            </div>
          </div>
        ) : null}
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-200">Duplicar configuração de evento</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Evento origem</span>
            <select value={duplicateSourceId} onChange={(event) => setDuplicateSourceId(event.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2">
              {events.map((event) => <option key={event.id} value={event.id}>{event.name} ({event.year ?? "—"})</option>)}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Novo nome</span>
            <input value={duplicateForm.target_name} onChange={(event) => setDuplicateForm((prev) => ({ ...prev, target_name: event.target.value, target_slug: prev.target_slug || slugify(event.target.value) }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Novo slug</span>
            <input value={duplicateForm.target_slug} onChange={(event) => setDuplicateForm((prev) => ({ ...prev, target_slug: slugify(event.target.value) }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Novo ano</span>
            <input value={duplicateForm.target_year} onChange={(event) => setDuplicateForm((prev) => ({ ...prev, target_year: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-3 text-sm text-slate-300">
          <label className="flex items-center gap-2"><input type="checkbox" checked={duplicateForm.copy_categories} onChange={(event) => setDuplicateForm((prev) => ({ ...prev, copy_categories: event.target.checked }))} /> Categorias</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={duplicateForm.copy_kit_items} onChange={(event) => setDuplicateForm((prev) => ({ ...prev, copy_kit_items: event.target.checked }))} /> Itens de kit</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={duplicateForm.copy_benefits} onChange={(event) => setDuplicateForm((prev) => ({ ...prev, copy_benefits: event.target.checked }))} /> Benefícios</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={duplicateForm.copy_batches} onChange={(event) => setDuplicateForm((prev) => ({ ...prev, copy_batches: event.target.checked }))} /> Lotes</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={duplicateForm.copy_batch_prices} onChange={(event) => setDuplicateForm((prev) => ({ ...prev, copy_batch_prices: event.target.checked }))} /> Preços por categoria</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={duplicateForm.copy_inventory_structure} onChange={(event) => setDuplicateForm((prev) => ({ ...prev, copy_inventory_structure: event.target.checked }))} /> Estrutura de estoque</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={duplicateForm.copy_coupons} onChange={(event) => setDuplicateForm((prev) => ({ ...prev, copy_coupons: event.target.checked }))} /> Copiar cupons</label>
        </div>

        <p className="mt-2 text-xs text-slate-400">O novo evento começará com estoque zerado.</p>

        <div className="mt-4">
          <button type="button" onClick={duplicate} disabled={isPending} className="rounded-xl border border-emerald-500/40 px-4 py-2 text-sm font-semibold text-emerald-200 disabled:opacity-60">Duplicar configuração</button>
        </div>
      </div>

      <div className="space-y-3">
        {events.map((item) => (
          <div key={item.id} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-base font-semibold text-slate-100">{item.name} {item.year ? `(${item.year})` : ""}</p>
                <p className="text-xs text-slate-400">Slug: {item.slug}</p>
                <p className="mt-1 text-sm text-slate-400">Período: {item.starts_at ? formatDateBR(item.starts_at) : "-"} até {item.ends_at ? formatDateBR(item.ends_at) : "-"}</p>
                <p className="text-sm text-slate-400">Inscritos: {item.participants_count}</p>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className={`rounded-full border px-3 py-1 ${item.registration_enabled ? "border-emerald-500/40 text-emerald-300" : "border-slate-700 text-slate-400"}`}>{item.registration_enabled ? "Vendas abertas" : "Vendas fechadas"}</span>
                <span className={`rounded-full border px-3 py-1 ${item.kit_enabled ? "border-cyan-500/40 text-cyan-300" : "border-slate-700 text-slate-400"}`}>{item.kit_enabled ? "Kit ativo" : "Sem kit"}</span>
                <span className={`rounded-full border px-3 py-1 ${item.is_active ? "border-amber-500/40 text-amber-300" : "border-slate-700 text-slate-400"}`}>{item.is_active ? "Evento ativo" : "Inativo"}</span>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  loadForEdit(item);
                }}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200"
              >
                Editar
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  activate(item);
                }}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200"
              >
                {item.is_active ? "Desativar" : "Ativar"}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleRegistration(item);
                }}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200"
              >
                {item.registration_enabled ? "Fechar vendas" : "Abrir vendas"}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  archive(item);
                }}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200"
              >
                Arquivar
              </button>
              <Link href={`/painel/eventos/${item.id}`} className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200">Detalhes</Link>
            </div>

            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-300">Eventos em destaque</p>
              <div className="mt-2 flex flex-wrap items-end gap-3 text-sm">
                <label className="flex items-center gap-2 text-slate-300">
                  <input
                    type="checkbox"
                    checked={highlightDraft[item.id]?.enabled ?? false}
                    onChange={(event) => setHighlightDraft((prev) => ({
                      ...prev,
                      [item.id]: {
                        enabled: event.target.checked,
                        sort_order: prev[item.id]?.sort_order ?? "0",
                      },
                    }))}
                  />
                  Exibir no bloco de destaques
                </label>
                <label className="space-y-1 text-xs text-slate-300">
                  <span>Ordem</span>
                  <input
                    value={highlightDraft[item.id]?.sort_order ?? "0"}
                    onChange={(event) => setHighlightDraft((prev) => ({
                      ...prev,
                      [item.id]: {
                        enabled: prev[item.id]?.enabled ?? false,
                        sort_order: event.target.value,
                      },
                    }))}
                    className="w-20 rounded-lg border border-slate-700 bg-slate-950/70 px-2 py-1"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => saveHighlight(item.id)}
                  className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200"
                >
                  Salvar destaque
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
