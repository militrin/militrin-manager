"use client";

import { useState } from "react";

/**
 * Confirmacao de check-in quando o ingresso JA tem pulseira ativa.
 * Nao pede leitura de uma pulseira nova -- e o caso Magna (refazer check-in).
 */
export function ConfirmCheckinDialog({
  wristbandCode,
  onConfirm,
  onClose,
}: {
  wristbandCode: string;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await onConfirm();
      const failed =
        result &&
        typeof result === "object" &&
        "success" in result &&
        (result as { success?: boolean }).success === false;
      if (failed) {
        setError((result as { message?: string }).message ?? "Não foi possível confirmar o check-in.");
        setSubmitting(false);
        return;
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível confirmar o check-in.");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={submitting ? undefined : onClose}>
      <div
        role="alertdialog"
        aria-modal="true"
        className="w-full max-w-sm rounded-t-3xl border border-cyan-500/30 bg-slate-950 p-5 sm:rounded-3xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-100">Confirmar check-in</h3>
        <p className="mt-1 text-sm text-slate-400">Este ingresso já possui pulseira vinculada. Nenhuma pulseira nova será lida.</p>

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-3">
          <p className="text-xs uppercase tracking-wide text-slate-500">Pulseira vinculada</p>
          <p className="mt-1 font-mono text-sm font-semibold text-cyan-100">{wristbandCode}</p>
        </div>

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
            onClick={() => void handleConfirm()}
            disabled={submitting}
            className="h-10 rounded-xl bg-cyan-500 px-4 text-sm font-semibold text-cyan-950 disabled:opacity-50"
          >
            {submitting ? "Confirmando..." : "Confirmar check-in"}
          </button>
        </div>
      </div>
    </div>
  );
}
