"use client";

import { useMemo, useState, useTransition } from "react";
import {
  createSingleTicketBatchAction,
  setSingleTicketBatchGenderClosedAction,
  updateSingleTicketBatchAction,
} from "@/app/eventos/actions";
import { DateTimeField } from "@/components/forms/DateTimeField";
import { SlideOverPanel } from "@/components/admin/SlideOverPanel";

export type SingleTicketBatchRow = {
  batchId: string;
  name: string;
  sequenceNumber: number;
  malePrice: number;
  femalePrice: number;
  maleMax: number;
  femaleMax: number;
  genderSplit: boolean;
  maleConfirmed: number;
  femaleConfirmed: number;
  maleClosed: boolean;
  femaleClosed: boolean;
  startsAt: string | null;
  endsAt: string | null;
  maleStatus: "disponivel" | "esgotado" | "futuro";
  femaleStatus: "disponivel" | "esgotado" | "futuro";
};

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
}

function ordinalLabel(value: number) {
  return `${value}º`;
}

function defaultBatchName(sequenceNumber: number) {
  return `${ordinalLabel(sequenceNumber)} Lote`;
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

const STATUS_LABEL: Record<SingleTicketBatchRow["maleStatus"], string> = {
  disponivel: "Disponível",
  esgotado: "Esgotado",
  futuro: "Futuro",
};

const STATUS_CLASS: Record<SingleTicketBatchRow["maleStatus"], string> = {
  disponivel: "border-emerald-500/40 text-emerald-300",
  esgotado: "border-rose-500/40 text-rose-300",
  futuro: "border-slate-700 text-slate-400",
};

type FormState = {
  id?: string;
  name: string;
  male_price: string;
  female_price: string;
  male_max: string;
  female_max: string;
  starts_at: string;
  ends_at: string;
};

function emptyForm(): FormState {
  return { name: "", male_price: "", female_price: "", male_max: "", female_max: "", starts_at: "", ends_at: "" };
}

export function SingleTicketBatchesManager({ eventId, batches }: { eventId: string; batches: SingleTicketBatchRow[] }) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());

  const sortedBatches = useMemo(() => [...batches].sort((a, b) => a.sequenceNumber - b.sequenceNumber), [batches]);
  const nextSequenceNumber = useMemo(
    () => sortedBatches.reduce((max, batch) => Math.max(max, batch.sequenceNumber), 0) + 1,
    [sortedBatches],
  );

  function openCreate() {
    setForm(emptyForm());
    setPanelOpen(true);
  }

  function openEdit(batch: SingleTicketBatchRow) {
    setForm({
      id: batch.batchId,
      name: batch.name,
      male_price: String(batch.malePrice),
      female_price: String(batch.femalePrice),
      male_max: String(batch.maleMax),
      female_max: String(batch.femaleMax),
      starts_at: toDatetimeLocal(batch.startsAt),
      ends_at: toDatetimeLocal(batch.endsAt),
    });
    setPanelOpen(true);
  }

  function submit() {
    setMessage(null);
    const malePrice = Number(form.male_price || 0);
    const femalePrice = Number(form.female_price || 0);
    const maleMax = Number(form.male_max || 0);
    const femaleMax = Number(form.female_max || 0);
    if (!form.name.trim()) {
      setMessage({ type: "error", text: "Informe o nome do lote." });
      return;
    }
    if (!Number.isInteger(maleMax) || maleMax <= 0 || !Number.isInteger(femaleMax) || femaleMax <= 0) {
      setMessage({ type: "error", text: "Informe limite masculino e feminino, maiores que zero." });
      return;
    }
    if (form.starts_at && form.ends_at && new Date(form.ends_at).getTime() < new Date(form.starts_at).getTime()) {
      setMessage({ type: "error", text: "Data final não pode ser anterior à data inicial." });
      return;
    }

    startTransition(async () => {
      const result = form.id
        ? await updateSingleTicketBatchAction(eventId, {
            batch_id: form.id,
            name: form.name,
            male_price: malePrice,
            female_price: femalePrice,
            male_max: maleMax,
            female_max: femaleMax,
            starts_at: form.starts_at || null,
            ends_at: form.ends_at || null,
          })
        : await createSingleTicketBatchAction({
            event_id: eventId,
            name: form.name,
            sequence_number: nextSequenceNumber,
            male_price: malePrice,
            female_price: femalePrice,
            male_max: maleMax,
            female_max: femaleMax,
            starts_at: form.starts_at || null,
            ends_at: form.ends_at || null,
            male_closed: false,
            female_closed: false,
          });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) setPanelOpen(false);
    });
  }

  function toggleGender(batch: SingleTicketBatchRow, gender: "male" | "female", closed: boolean) {
    setMessage(null);
    startTransition(async () => {
      const result = await setSingleTicketBatchGenderClosedAction({ batch_id: batch.batchId, event_id: eventId, gender, closed });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-400">{sortedBatches.length === 0 ? "Nenhum lote cadastrado." : `${sortedBatches.length} lote(s) cadastrado(s).`}</p>
        <button type="button" onClick={openCreate} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950">
          + Adicionar lote
        </button>
      </div>

      {message ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
          {message.text}
        </div>
      ) : null}

      <div className="space-y-2">
        {sortedBatches.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/40 p-6 text-center text-sm text-slate-400">
            Nenhum lote cadastrado para o ingresso único deste evento.
          </div>
        ) : (
          sortedBatches.map((batch) => (
            <div key={batch.batchId} className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-slate-800/80 text-sm font-bold text-slate-200">
                    {ordinalLabel(batch.sequenceNumber)}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-100">{batch.name}</p>
                    <p className="mt-0.5 text-xs text-slate-400">{periodLabel(batch.startsAt, batch.endsAt)}</p>
                  </div>
                </div>
                <button type="button" onClick={() => openEdit(batch)} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500">
                  Editar
                </button>
              </div>

              <div className="mt-3 grid gap-2 md:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-200">Masculino</span>
                    <span className={`rounded-full border px-2.5 py-0.5 text-[11px] ${STATUS_CLASS[batch.maleStatus]}`}>{STATUS_LABEL[batch.maleStatus]}</span>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-emerald-300">{money(batch.malePrice)}</p>
                  <p className="mt-1 text-slate-400">Limite: {batch.maleMax} · Vendidos: {batch.maleConfirmed} · Disponíveis: {Math.max(batch.maleMax - batch.maleConfirmed, 0)}</p>
                  <button
                    type="button"
                    onClick={() => toggleGender(batch, "male", !batch.maleClosed)}
                    disabled={isPending}
                    className="mt-2 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-200 hover:border-slate-500 disabled:opacity-40"
                  >
                    {batch.maleClosed ? "Reabrir masculino" : "Esgotar / Encerrar masculino"}
                  </button>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-200">Feminino</span>
                    <span className={`rounded-full border px-2.5 py-0.5 text-[11px] ${STATUS_CLASS[batch.femaleStatus]}`}>{STATUS_LABEL[batch.femaleStatus]}</span>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-emerald-300">{money(batch.femalePrice)}</p>
                  <p className="mt-1 text-slate-400">Limite: {batch.femaleMax} · Vendidos: {batch.femaleConfirmed} · Disponíveis: {Math.max(batch.femaleMax - batch.femaleConfirmed, 0)}</p>
                  <button
                    type="button"
                    onClick={() => toggleGender(batch, "female", !batch.femaleClosed)}
                    disabled={isPending}
                    className="mt-2 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-200 hover:border-slate-500 disabled:opacity-40"
                  >
                    {batch.femaleClosed ? "Reabrir feminino" : "Esgotar / Encerrar feminino"}
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <SlideOverPanel open={panelOpen} title={form.id ? "Editar lote" : "Novo lote"} onClose={() => setPanelOpen(false)}>
        <div className="space-y-4">
          <label className="block space-y-1 text-sm">
            <span className="text-slate-300">Nome do lote</span>
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder={defaultBatchName(form.id ? sortedBatches.find((batch) => batch.batchId === form.id)?.sequenceNumber ?? nextSequenceNumber : nextSequenceNumber)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Preço masculino</span>
              <input value={form.male_price} onChange={(event) => setForm((prev) => ({ ...prev, male_price: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Preço feminino</span>
              <input value={form.female_price} onChange={(event) => setForm((prev) => ({ ...prev, female_price: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Limite masculino</span>
              <input value={form.male_max} onChange={(event) => setForm((prev) => ({ ...prev, male_max: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Limite feminino</span>
              <input value={form.female_max} onChange={(event) => setForm((prev) => ({ ...prev, female_max: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
            </label>
          </div>

          <DateTimeField label="Início (opcional)" value={form.starts_at} onChange={(value) => setForm((prev) => ({ ...prev, starts_at: value }))} />
          <DateTimeField label="Fim (opcional)" value={form.ends_at} onChange={(value) => setForm((prev) => ({ ...prev, ends_at: value }))} />

          <button type="button" onClick={submit} disabled={isPending} className="w-full rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
            {isPending ? "Salvando..." : form.id ? "Atualizar lote" : "Criar lote"}
          </button>
        </div>
      </SlideOverPanel>
    </div>
  );
}
