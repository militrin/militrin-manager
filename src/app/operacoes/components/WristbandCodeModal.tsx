"use client";

import { useState } from "react";

/**
 * Modal generico de "codigo da pulseira" -- reusado em 3 fluxos: vincular
 * pela ficha do ingresso, trocar (substituir a ativa) e o vinculo
 * OBRIGATORIO disparado por checkin/entrega quando o evento exige pulseira
 * e o ingresso ainda nao tem uma (nesse caso `mandatory` fica true e o
 * fechar/cancelar do modal so cancela a operacao que pediu a pulseira,
 * nunca conclui check-in/entrega sem ela). Aceita digitacao/colagem --
 * leitura por NFC/QR pode escrever no mesmo campo no futuro sem mudar este
 * componente.
 */
export function WristbandCodeModal({
  title,
  description,
  submitLabel,
  mandatory,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  mandatory?: boolean;
  onSubmit: (code: string) => Promise<{ success: boolean; message?: string }>;
  onClose: () => void;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    const trimmed = code.trim();
    if (!trimmed) {
      setError("Informe o código da pulseira.");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await onSubmit(trimmed);
    setSubmitting(false);
    if (!result.success) {
      setError(result.message ?? "Não foi possível concluir a operação.");
      return;
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={mandatory ? undefined : onClose}>
      <div
        className="w-full max-w-sm rounded-t-3xl border border-cyan-500/30 bg-slate-950 p-5 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-100">{title}</h3>
        {description ? <p className="mt-1 text-sm text-slate-400">{description}</p> : null}
        {mandatory ? (
          <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            Este evento exige pulseira vinculada para concluir esta operação.
          </p>
        ) : null}

        <label className="mt-4 block space-y-1">
          <span className="text-xs text-slate-300">Código da pulseira</span>
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSubmit(); }}
            placeholder="Digite, cole ou leia o código"
            className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100"
          />
        </label>

        {error ? <p className="mt-2 text-xs text-rose-300" role="alert">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          {mandatory ? null : (
            <button type="button" onClick={onClose} disabled={submitting} className="h-10 rounded-xl border border-slate-700 px-4 text-sm text-slate-300 disabled:opacity-50">
              Cancelar
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="h-10 rounded-xl bg-cyan-500 px-4 text-sm font-semibold text-cyan-950 disabled:opacity-50"
          >
            {submitting ? "Salvando..." : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
