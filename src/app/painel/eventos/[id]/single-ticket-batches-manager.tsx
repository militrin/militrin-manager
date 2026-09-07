"use client";

import { useMemo, useState, useTransition } from "react";
import {
  createSingleTicketUnisexBatchAction,
  setSingleTicketBatchClosedAction,
  setSingleTicketBatchGenderClosedAction,
  updateSingleTicketBatchAction,
  updateSingleTicketUnisexBatchAction,
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

type UnisexFormState = {
  id?: string;
  name: string;
  price: string;
  max: string;
  starts_at: string;
  ends_at: string;
};

type GenderFormState = {
  id?: string;
  name: string;
  male_price: string;
  female_price: string;
  male_max: string;
  female_max: string;
  starts_at: string;
  ends_at: string;
};

function emptyUnisexForm(): UnisexFormState {
  return { name: "", price: "", max: "", starts_at: "", ends_at: "" };
}

function emptyGenderForm(): GenderFormState {
  return { name: "", male_price: "", female_price: "", male_max: "", female_max: "", starts_at: "", ends_at: "" };
}

export function SingleTicketBatchesManager({ eventId, batches }: { eventId: string; batches: SingleTicketBatchRow[] }) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [unisexPanelOpen, setUnisexPanelOpen] = useState(false);
  const [genderPanelOpen, setGenderPanelOpen] = useState(false);
  const [unisexForm, setUnisexForm] = useState<UnisexFormState>(emptyUnisexForm());
  const [genderForm, setGenderForm] = useState<GenderFormState>(emptyGenderForm());

  const sortedBatches = useMemo(() => [...batches].sort((a, b) => a.sequenceNumber - b.sequenceNumber), [batches]);
  const nextSequenceNumber = useMemo(
    () => sortedBatches.reduce((max, batch) => Math.max(max, batch.sequenceNumber), 0) + 1,
    [sortedBatches],
  );

  function openCreate() {
    setUnisexForm(emptyUnisexForm());
    setUnisexPanelOpen(true);
  }

  function openEdit(batch: SingleTicketBatchRow) {
    if (batch.genderSplit) {
      setGenderForm({
        id: batch.batchId,
        name: batch.name,
        male_price: String(batch.malePrice),
        female_price: String(batch.femalePrice),
        male_max: String(batch.maleMax),
        female_max: String(batch.femaleMax),
        starts_at: toDatetimeLocal(batch.startsAt),
        ends_at: toDatetimeLocal(batch.endsAt),
      });
      setGenderPanelOpen(true);
      return;
    }
    setUnisexForm({
      id: batch.batchId,
      name: batch.name,
      price: String(batch.malePrice),
      max: String(batch.maleMax),
      starts_at: toDatetimeLocal(batch.startsAt),
      ends_at: toDatetimeLocal(batch.endsAt),
    });
    setUnisexPanelOpen(true);
  }

  function submitUnisex() {
    setMessage(null);
    const price = Number(unisexForm.price || 0);
    const max = Number(unisexForm.max || 0);
    if (!unisexForm.name.trim()) {
      setMessage({ type: "error", text: "Informe o nome do lote." });
      return;
    }
    if (Number.isNaN(price) || price < 0) {
      setMessage({ type: "error", text: "Informe um preço válido." });
      return;
    }
    if (!Number.isInteger(max) || max <= 0) {
      setMessage({ type: "error", text: "Informe um limite maior que zero." });
      return;
    }
    if (unisexForm.starts_at && unisexForm.ends_at && new Date(unisexForm.ends_at).getTime() < new Date(unisexForm.starts_at).getTime()) {
      setMessage({ type: "error", text: "Data final não pode ser anterior à data inicial." });
      return;
    }

    startTransition(async () => {
      const result = unisexForm.id
        ? await updateSingleTicketUnisexBatchAction(eventId, {
            batch_id: unisexForm.id,
            name: unisexForm.name,
            price,
            max,
            starts_at: unisexForm.starts_at || null,
            ends_at: unisexForm.ends_at || null,
          })
        : await createSingleTicketUnisexBatchAction({
            event_id: eventId,
            name: unisexForm.name,
            sequence_number: nextSequenceNumber,
            price,
            max,
            starts_at: unisexForm.starts_at || null,
            ends_at: unisexForm.ends_at || null,
            closed: false,
          });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) setUnisexPanelOpen(false);
    });
  }

  function submitGender() {
    setMessage(null);
    const malePrice = Number(genderForm.male_price || 0);
    const femalePrice = Number(genderForm.female_price || 0);
    const maleMax = Number(genderForm.male_max || 0);
    const femaleMax = Number(genderForm.female_max || 0);
    if (!genderForm.id) return;
    if (!genderForm.name.trim()) {
      setMessage({ type: "error", text: "Informe o nome do lote." });
      return;
    }
    if (!Number.isInteger(maleMax) || maleMax <= 0 || !Number.isInteger(femaleMax) || femaleMax <= 0) {
      setMessage({ type: "error", text: "Informe limite masculino e feminino, maiores que zero." });
      return;
    }
    if (genderForm.starts_at && genderForm.ends_at && new Date(genderForm.ends_at).getTime() < new Date(genderForm.starts_at).getTime()) {
      setMessage({ type: "error", text: "Data final não pode ser anterior à data inicial." });
      return;
    }

    startTransition(async () => {
      const result = await updateSingleTicketBatchAction(eventId, {
        batch_id: genderForm.id!,
        name: genderForm.name,
        male_price: malePrice,
        female_price: femalePrice,
        male_max: maleMax,
        female_max: femaleMax,
        starts_at: genderForm.starts_at || null,
        ends_at: genderForm.ends_at || null,
      });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) setGenderPanelOpen(false);
    });
  }

  function toggleLot(batch: SingleTicketBatchRow, closed: boolean) {
    setMessage(null);
    startTransition(async () => {
      const result = await setSingleTicketBatchClosedAction({ batch_id: batch.batchId, event_id: eventId, closed });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
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
                    {batch.genderSplit ? (
                      <p className="mt-1 text-[11px] text-amber-200">Lote legado com preço/limite por gênero — vendas históricas preservadas.</p>
                    ) : null}
                  </div>
                </div>
                <button type="button" onClick={() => openEdit(batch)} className="rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:border-slate-500">
                  Editar
                </button>
              </div>

              {batch.genderSplit ? (
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
              ) : (
                <div className="mt-3 rounded-xl border border-slate-800 bg-slate-900/50 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-200">Ingresso único</span>
                    <span className={`rounded-full border px-2.5 py-0.5 text-[11px] ${STATUS_CLASS[batch.maleStatus]}`}>{STATUS_LABEL[batch.maleStatus]}</span>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-emerald-300">{money(batch.malePrice)}</p>
                  <p className="mt-1 text-slate-400">Limite: {batch.maleMax} · Vendidos: {batch.maleConfirmed} · Disponíveis: {Math.max(batch.maleMax - batch.maleConfirmed, 0)}</p>
                  <button
                    type="button"
                    onClick={() => toggleLot(batch, !(batch.maleClosed || batch.femaleClosed))}
                    disabled={isPending}
                    className="mt-2 rounded-lg border border-slate-700 px-2.5 py-1 text-[11px] text-slate-200 hover:border-slate-500 disabled:opacity-40"
                  >
                    {batch.maleClosed || batch.femaleClosed ? "Reabrir lote" : "Esgotar / Encerrar lote"}
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <SlideOverPanel open={unisexPanelOpen} title={unisexForm.id ? "Editar lote" : "Novo lote"} onClose={() => setUnisexPanelOpen(false)}>
        <div className="space-y-4">
          <label className="block space-y-1 text-sm">
            <span className="text-slate-300">Nome do lote</span>
            <input
              value={unisexForm.name}
              onChange={(event) => setUnisexForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder={defaultBatchName(unisexForm.id ? sortedBatches.find((batch) => batch.batchId === unisexForm.id)?.sequenceNumber ?? nextSequenceNumber : nextSequenceNumber)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Preço</span>
              <input value={unisexForm.price} onChange={(event) => setUnisexForm((prev) => ({ ...prev, price: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Limite</span>
              <input value={unisexForm.max} onChange={(event) => setUnisexForm((prev) => ({ ...prev, max: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
            </label>
          </div>

          <DateTimeField label="Início (opcional)" value={unisexForm.starts_at} onChange={(value) => setUnisexForm((prev) => ({ ...prev, starts_at: value }))} />
          <DateTimeField label="Fim (opcional)" value={unisexForm.ends_at} onChange={(value) => setUnisexForm((prev) => ({ ...prev, ends_at: value }))} />

          <button type="button" onClick={submitUnisex} disabled={isPending} className="w-full rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
            {isPending ? "Salvando..." : unisexForm.id ? "Atualizar lote" : "Criar lote"}
          </button>
        </div>
      </SlideOverPanel>

      <SlideOverPanel open={genderPanelOpen} title="Editar lote legado" onClose={() => setGenderPanelOpen(false)}>
        <div className="space-y-4">
          <p className="text-xs text-amber-200">Este lote já vende com preço e limite separados por gênero. A edição preserva esse modelo.</p>
          <label className="block space-y-1 text-sm">
            <span className="text-slate-300">Nome do lote</span>
            <input
              value={genderForm.name}
              onChange={(event) => setGenderForm((prev) => ({ ...prev, name: event.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Preço masculino</span>
              <input value={genderForm.male_price} onChange={(event) => setGenderForm((prev) => ({ ...prev, male_price: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Preço feminino</span>
              <input value={genderForm.female_price} onChange={(event) => setGenderForm((prev) => ({ ...prev, female_price: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Limite masculino</span>
              <input value={genderForm.male_max} onChange={(event) => setGenderForm((prev) => ({ ...prev, male_max: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-slate-300">Limite feminino</span>
              <input value={genderForm.female_max} onChange={(event) => setGenderForm((prev) => ({ ...prev, female_max: event.target.value }))} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
            </label>
          </div>

          <DateTimeField label="Início (opcional)" value={genderForm.starts_at} onChange={(value) => setGenderForm((prev) => ({ ...prev, starts_at: value }))} />
          <DateTimeField label="Fim (opcional)" value={genderForm.ends_at} onChange={(value) => setGenderForm((prev) => ({ ...prev, ends_at: value }))} />

          <button type="button" onClick={submitGender} disabled={isPending} className="w-full rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
            {isPending ? "Salvando..." : "Atualizar lote"}
          </button>
        </div>
      </SlideOverPanel>
    </div>
  );
}
