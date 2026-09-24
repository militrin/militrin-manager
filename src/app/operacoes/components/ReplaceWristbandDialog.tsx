"use client";

import { useState } from "react";
import {
  WRISTBAND_REPLACE_REASON_CODES,
  WRISTBAND_REPLACE_REASON_CODE_LABELS,
  type WristbandReplaceReasonCode,
} from "../types";

export function ReplaceWristbandDialog({
  currentCode,
  onSubmit,
  onClose,
}: {
  currentCode: string;
  onSubmit: (payload: {
    newCode: string;
    reasonCode: WristbandReplaceReasonCode;
    reasonText: string;
  }) => Promise<{ success: boolean; message?: string }>;
  onClose: () => void;
}) {
  const [newCode, setNewCode] = useState("");
  const [reasonCode, setReasonCode] = useState<WristbandReplaceReasonCode | "">("");
  const [reasonText, setReasonText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    const trimmed = newCode.trim();
    if (!trimmed) {
      setError("Informe o código da nova pulseira.");
      return;
    }
    if (!reasonCode) {
      setError("Selecione um motivo.");
      return;
    }
    if (reasonCode === "other" && !reasonText.trim()) {
      setError('Descreva o motivo quando selecionar "Outro".');
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await onSubmit({
      newCode: trimmed,
      reasonCode,
      reasonText: reasonText.trim(),
    });
    setSubmitting(false);
    if (!result.success) {
      setError(result.message ?? "Não foi possível substituir a pulseira.");
      return;
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-t-3xl border border-cyan-500/30 bg-slate-950 p-5 sm:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-100">Substituir pulseira</h3>
        <p className="mt-1 text-sm text-slate-400">A pulseira atual será desativada e a nova ficará vinculada a este ingresso.</p>

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Pulseira atual</p>
          <p className="mt-1 font-mono text-sm font-semibold text-cyan-100">{currentCode}</p>
        </div>

        <label className="mt-4 block space-y-1">
          <span className="text-xs text-slate-300">Nova pulseira</span>
          <input
            autoFocus
            value={newCode}
            onChange={(event) => setNewCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleSubmit();
            }}
            placeholder="Escanear ou digitar"
            className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 font-mono text-sm text-slate-100"
          />
        </label>

        <label className="mt-3 block space-y-1">
          <span className="text-xs text-slate-300">Motivo</span>
          <select
            value={reasonCode}
            onChange={(event) => setReasonCode(event.target.value as WristbandReplaceReasonCode)}
            className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100"
          >
            <option value="">Selecione</option>
            {WRISTBAND_REPLACE_REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {WRISTBAND_REPLACE_REASON_CODE_LABELS[code]}
              </option>
            ))}
          </select>
        </label>

        {reasonCode === "other" ? (
          <label className="mt-3 block space-y-1">
            <span className="text-xs text-slate-300">Descreva o motivo</span>
            <textarea
              value={reasonText}
              onChange={(event) => setReasonText(event.target.value)}
              rows={3}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            />
          </label>
        ) : null}

        {error ? (
          <p className="mt-2 text-xs text-rose-300" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-10 rounded-xl border border-slate-700 px-4 text-sm text-slate-300 disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="h-10 rounded-xl bg-cyan-500 px-4 text-sm font-semibold text-cyan-950 disabled:opacity-50"
          >
            {submitting ? "Substituindo..." : "Substituir pulseira"}
          </button>
        </div>
      </div>
    </div>
  );
}
