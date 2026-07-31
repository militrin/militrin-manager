"use client";

import { useMemo, useState, useTransition } from "react";
import {
  deleteEventAddonOptionAction,
  upsertBatchAddonOptionAction,
  upsertEventAddonOptionAction,
  upsertEventAddonsModelAction,
} from "@/app/eventos/actions";

type AddonOption = {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
};

type BatchRow = {
  id: string;
  name: string;
  sequence_number: number;
};

type EventAddonsManagerProps = {
  eventId: string;
  initialApplyToAllBatches: boolean;
  options: AddonOption[];
  batches: BatchRow[];
  assignments: Record<string, boolean>;
};

export function EventAddonsManager({
  eventId,
  initialApplyToAllBatches,
  options,
  batches,
  assignments,
}: EventAddonsManagerProps) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [modelConfig, setModelConfig] = useState({
    apply_to_all_batches: initialApplyToAllBatches,
  });

  const [optionForm, setOptionForm] = useState({
    id: "",
    name: "",
    description: "",
    sort_order: "0",
    is_active: true,
  });

  const [batchAssignments, setBatchAssignments] = useState<Record<string, boolean>>(assignments);

  const orderedBatches = useMemo(
    () => [...batches].sort((a, b) => Number(a.sequence_number ?? 0) - Number(b.sequence_number ?? 0)),
    [batches],
  );

  const orderedOptions = useMemo(
    () => [...options].sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) || a.name.localeCompare(b.name)),
    [options],
  );

  function saveModelConfig() {
    setMessage(null);
    startTransition(async () => {
      const result = await upsertEventAddonsModelAction({
        event_id: eventId,
        apply_to_all_batches: modelConfig.apply_to_all_batches,
      });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  function saveAddonOption() {
    setMessage(null);
    startTransition(async () => {
      const result = await upsertEventAddonOptionAction({
        event_id: eventId,
        id: optionForm.id || undefined,
        name: optionForm.name,
        description: optionForm.description || null,
        sort_order: Number(optionForm.sort_order || 0),
        is_active: optionForm.is_active,
      });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) {
        setOptionForm({ id: "", name: "", description: "", sort_order: "0", is_active: true });
      }
    });
  }

  function editAddonOption(option: AddonOption) {
    setOptionForm({
      id: option.id,
      name: option.name,
      description: option.description ?? "",
      sort_order: String(option.sort_order ?? 0),
      is_active: option.is_active,
    });
  }

  function removeAddonOption(optionId: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await deleteEventAddonOptionAction({ event_id: eventId, option_id: optionId });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  function saveBatchOption(batchId: string, optionId: string) {
    const key = `${batchId}:${optionId}`;
    const enabled = Boolean(batchAssignments[key]);
    setMessage(null);
    startTransition(async () => {
      const result = await upsertBatchAddonOptionAction({
        event_id: eventId,
        batch_id: batchId,
        option_id: optionId,
        enabled,
      });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
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
        <p className="text-sm font-semibold text-slate-100">Modelo de adicionais</p>
        <p className="mt-1 text-xs text-slate-400">Cadastre os adicionais que fizerem sentido para este evento (ex.: pulseira premium, estacionamento, copo eco, acesso backstage) e escolha se valem para todos os lotes ou por lote.</p>

        <div className="mt-3 space-y-2 text-sm text-slate-200">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={modelConfig.apply_to_all_batches}
              onChange={() => setModelConfig((prev) => ({ ...prev, apply_to_all_batches: true }))}
            />
            Mesma configuração para todos os lotes
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={!modelConfig.apply_to_all_batches}
              onChange={() => setModelConfig((prev) => ({ ...prev, apply_to_all_batches: false }))}
            />
            Configuração específica por lote
          </label>
        </div>

        <div className="mt-4">
          <button
            type="button"
            onClick={saveModelConfig}
            disabled={isPending}
            className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60"
          >
            Salvar modelo de adicionais
          </button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-100">Adicionais disponíveis no evento</p>
        <p className="mt-1 text-xs text-slate-400">Crie adicionais personalizados. Eles aparecerão para aplicar em todos os lotes ou por lote.</p>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Nome do adicional</span>
            <input
              value={optionForm.name}
              onChange={(event) => setOptionForm((prev) => ({ ...prev, name: event.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Ordem</span>
            <input
              value={optionForm.sort_order}
              onChange={(event) => setOptionForm((prev) => ({ ...prev, sort_order: event.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>
          <label className="space-y-1 text-sm md:col-span-2">
            <span className="text-slate-300">Descrição (opcional)</span>
            <input
              value={optionForm.description}
              onChange={(event) => setOptionForm((prev) => ({ ...prev, description: event.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>
        </div>

        <label className="mt-3 inline-flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={optionForm.is_active}
            onChange={(event) => setOptionForm((prev) => ({ ...prev, is_active: event.target.checked }))}
          />
          Adicional ativo
        </label>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={saveAddonOption} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
            {optionForm.id ? "Atualizar adicional" : "Adicionar"}
          </button>
          {optionForm.id ? (
            <button type="button" onClick={() => setOptionForm({ id: "", name: "", description: "", sort_order: "0", is_active: true })} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300">
              Cancelar edição
            </button>
          ) : null}
        </div>

        <div className="mt-4 space-y-2">
          {orderedOptions.length === 0 ? (
            <p className="text-sm text-slate-400">Nenhum adicional cadastrado ainda.</p>
          ) : (
            orderedOptions.map((option) => (
              <div key={option.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                <p className="font-semibold text-white">{option.name}</p>
                <p className="text-xs text-slate-300">{option.description ?? "Sem descrição"}</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => editAddonOption(option)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200">Editar</button>
                  <button type="button" onClick={() => removeAddonOption(option.id)} className="rounded-lg border border-rose-700 px-3 py-1.5 text-xs text-rose-200">Remover</button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {!modelConfig.apply_to_all_batches ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-sm font-semibold text-slate-100">Adicionais por lote</p>
          <p className="mt-1 text-xs text-slate-400">Marque quais adicionais estarão disponíveis em cada lote.</p>

          <div className="mt-3 space-y-3">
            {orderedBatches.length === 0 ? (
              <p className="text-sm text-slate-400">Crie lotes para configurar adicionais específicos.</p>
            ) : (
              orderedBatches.map((batch) => {
                return (
                  <div key={batch.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                    <p className="text-sm font-semibold text-white">{batch.name || `${batch.sequence_number}º Lote`}</p>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2 text-sm text-slate-300">
                      {orderedOptions.map((option) => {
                        const key = `${batch.id}:${option.id}`;
                        return (
                          <label key={option.id} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={Boolean(batchAssignments[key])}
                              onChange={(event) => setBatchAssignments((prev) => ({ ...prev, [key]: event.target.checked }))}
                            />
                            {option.name}
                          </label>
                        );
                      })}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {orderedOptions.map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          onClick={() => saveBatchOption(batch.id, option.id)}
                          disabled={isPending}
                          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 disabled:opacity-60"
                        >
                          Salvar {option.name}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
