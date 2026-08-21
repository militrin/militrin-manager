"use client";

import { useState } from "react";
import { REASON_CODES, REASON_CODE_LABELS, type ReasonCode } from "../types";

/**
 * Modal de motivo obrigatorio -- reusado por "Desfazer check-in" e
 * "Desfazer entrega". Motivo sempre exigido; texto livre so obrigatorio
 * quando o codigo e "other". `extraOption`, quando presente, renderiza um
 * checkbox adicional DESMARCADO por padrao (usado por "Desfazer check-in"
 * pra "Também desvincular a pulseira" -- nunca marcado automaticamente).
 */
export function ReasonDialog({
  title,
  description,
  submitLabel,
  extraOptionLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  extraOptionLabel?: string;
  onSubmit: (payload: { reasonCode: ReasonCode; reasonText: string; extraOption: boolean }) => Promise<{ success: boolean; message?: string }>;
  onClose: () => void;
}) {
  const [reasonCode, setReasonCode] = useState<ReasonCode | "">("");
  const [reasonText, setReasonText] = useState("");
  const [extraOption, setExtraOption] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
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
    const result = await onSubmit({ reasonCode, reasonText: reasonText.trim(), extraOption });
    setSubmitting(false);
    if (!result.success) {
      setError(result.message ?? "Não foi possível concluir a operação.");
      return;
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-t-3xl border border-rose-500/30 bg-slate-950 p-5 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        {description ? <p className="mt-1 text-sm text-slate-400">{description}</p> : null}

        <label className="mt-4 block space-y-1">
          <span className="text-xs text-slate-300">Motivo</span>
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value as ReasonCode)}
            className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100"
          >
            <option value="">Selecione</option>
            {REASON_CODES.map((code) => (
              <option key={code} value={code}>{REASON_CODE_LABELS[code]}</option>
            ))}
          </select>
        </label>

        {reasonCode === "other" ? (
          <label className="mt-3 block space-y-1">
            <span className="text-xs text-slate-300">Descreva o motivo</span>
            <textarea
              value={reasonText}
              onChange={(e) => setReasonText(e.target.value)}
              rows={3}
              className="w-full rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            />
          </label>
        ) : null}

        {extraOptionLabel ? (
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={extraOption} onChange={(e) => setExtraOption(e.target.checked)} className="h-4 w-4 rounded border-slate-600" />
            {extraOptionLabel}
          </label>
        ) : null}

        {error ? <p className="mt-2 text-xs text-rose-300" role="alert">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={submitting} className="h-10 rounded-xl border border-slate-700 px-4 text-sm text-slate-300 disabled:opacity-50">
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="h-10 rounded-xl bg-rose-500 px-4 text-sm font-semibold text-rose-950 disabled:opacity-50"
          >
            {submitting ? "Enviando..." : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
