"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import {
  activateEventAction,
  archiveEventAction,
  deactivateEventAction,
  duplicateEventAction,
  removeEventHighlightAction,
  restoreEventAction,
  setEventHighlightAction,
  setEventRegistrationEnabledAction,
} from "./actions";
import { formatDateBR } from "@/lib/utils/date";

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
  min_age: number;
  participants_count: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  archived_by: string | null;
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
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const emptyDuplicateForm = {
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
};

export function EventsManager({
  events,
  activeEvents,
  highlights,
  canCreate,
  canEdit,
  canPublish,
  canArchive,
}: {
  events: EventRow[];
  activeEvents: { id: string; name: string }[];
  highlights: HighlightRow[];
  canCreate: boolean;
  canEdit: boolean;
  canPublish: boolean;
  canArchive: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [cloneItem, setCloneItem] = useState<EventRow | null>(null);
  const [duplicateForm, setDuplicateForm] = useState(emptyDuplicateForm);
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

  const eventCountLabel = useMemo(() => {
    if (events.length === 1) return "1 evento cadastrado";
    return `${events.length} eventos cadastrados`;
  }, [events.length]);

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
    if (!window.confirm("Arquivar este evento? Ele será desativado e suas vendas serão fechadas.")) return;
    setMessage(null);
    startTransition(async () => {
      const result = await archiveEventAction(item.id);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  function restore(item: EventRow) {
    setMessage(null);
    startTransition(async () => {
      const result = await restoreEventAction(item.id);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  function openCloneModal(item: EventRow) {
    setCloneItem(item);
    setDuplicateForm({
      ...emptyDuplicateForm,
      target_name: `${item.name} (cópia)`,
      target_year: item.year !== null ? String(item.year) : "",
    });
    setMessage(null);
  }

  function closeCloneModal() {
    setCloneItem(null);
    setDuplicateForm(emptyDuplicateForm);
  }

  function duplicate() {
    if (!cloneItem) return;
    setMessage(null);
    startTransition(async () => {
      const result = await duplicateEventAction({
        source_event_id: cloneItem.id,
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
      if (!result.success) {
        setMessage({ type: "error", text: result.message });
        return;
      }
      closeCloneModal();
      if ("eventId" in result && result.eventId) {
        router.push(`/painel/eventos/${String(result.eventId)}?etapa=2`);
        return;
      }
      setMessage({ type: "success", text: result.message });
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
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-slate-400">{eventCountLabel}</p>
            <p className="text-sm text-slate-400">Eventos ativos: <span className="text-slate-200">{activeEvents.length ? activeEvents.map((event) => event.name).join(", ") : "Nenhum"}</span></p>
          </div>
          {canCreate ? <Link href="/painel/eventos/novo" className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950">
            + Novo evento
          </Link> : null}
        </div>

        {message ? (
          <div className={`mt-3 rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
            {message.text}
          </div>
        ) : null}
      </div>

      {cloneItem ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" onClick={closeCloneModal}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950 p-5" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between gap-3">
              <p className="text-base font-semibold text-slate-100">Clonar evento</p>
              <button type="button" onClick={closeCloneModal} className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800">Fechar</button>
            </div>
            <p className="mt-1 text-xs text-slate-400">Evento origem: <span className="text-slate-200">{cloneItem.name} {cloneItem.year ? `(${cloneItem.year})` : ""}</span></p>
            <p className="mt-2 text-xs text-slate-400">As configurações abaixo são copiadas do evento origem. Depois de clonar, você segue direto para o passo a passo do novo evento para revisar tudo antes de publicar.</p>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
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

            <p className="mt-2 text-xs text-slate-400">O novo evento começará com estoque zerado e a mesma idade mínima do evento origem ({cloneItem.min_age > 0 ? `${cloneItem.min_age} anos` : "sem restrição"}).</p>

            <div className="mt-4 flex gap-2">
              <button type="button" onClick={duplicate} disabled={isPending} className="rounded-xl border border-emerald-500/40 px-4 py-2 text-sm font-semibold text-emerald-200 disabled:opacity-60">
                {isPending ? "Clonando..." : "Clonar evento"}
              </button>
              <button type="button" onClick={closeCloneModal} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300">Cancelar</button>
            </div>
          </div>
        </div>
      ) : null}

      {(() => {
        const activeList = events.filter((item) => !item.archived_at);
        const archivedList = events.filter((item) => item.archived_at);

        function renderEventCard(item: EventRow) {
          return (
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
                <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-400">{item.min_age > 0 ? `${item.min_age}+` : "Todas as idades"}</span>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {!item.archived_at && canEdit ? <Link
                href={`/painel/eventos/${item.id}?etapa=1`}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200"
              >
                Editar
              </Link> : null}
              {!item.archived_at && canCreate ? <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openCloneModal(item);
                }}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200"
              >
                Clonar
              </button> : null}
              {!item.archived_at && canPublish ? <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  activate(item);
                }}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200"
              >
                {item.is_active ? "Desativar" : "Ativar"}
              </button> : null}
              {!item.archived_at && canPublish ? <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  toggleRegistration(item);
                }}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200"
              >
                {item.registration_enabled ? "Fechar vendas" : "Abrir vendas"}
              </button> : null}
              {item.archived_at && canArchive ? <button type="button" onClick={() => restore(item)} className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200">Restaurar</button> : null}
              {canArchive && !item.archived_at ? <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  archive(item);
                }}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200"
              >
                Arquivar
              </button> : null}
              <Link href={`/painel/eventos/${item.id}`} className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200">Detalhes</Link>
            </div>

            {canEdit ? <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/60 p-3">
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
            </div> : null}
          </div>
          );
        }

        return (
          <>
            <div className="space-y-3">
              <p className="text-sm font-semibold text-slate-200">Eventos</p>
              {activeList.length === 0 ? (
                <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-400">Nenhum evento cadastrado.</div>
              ) : activeList.map(renderEventCard)}
            </div>

            {archivedList.length > 0 ? (
              <div className="space-y-3">
                <p className="text-sm font-semibold text-slate-200">Eventos arquivados</p>
                {archivedList.map(renderEventCard)}
              </div>
            ) : null}
          </>
        );
      })()}

    </div>
  );
}
