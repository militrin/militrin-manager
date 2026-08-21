"use client";

import { useState } from "react";

/**
 * Confirmacao obrigatoria antes de "Entregar + check-in" -- a acao combinada
 * que entrega o kit E faz check-in numa unica chamada (deliver_items_and_
 * checkin, atomica no backend). A confirmacao aqui e so UX: quem decide se a
 * operacao e segura/atomica continua sendo a RPC, este componente nunca
 * chama entrega e check-in separadamente, so dispara `onConfirm` (que por
 * sua vez chama a MESMA acao combinada de sempre) depois do clique
 * explicito. Reusado tanto na ficha expandida quanto na linha da tabela --
 * por isso os dados de kit/pulseira sao paramnetros simples, cada chamador
 * manda o que tiver disponivel.
 */
export function ConfirmDeliverAndCheckinDialog({
  participantName,
  categoryName,
  kitItemLabels,
  hasKit,
  wristbandCode,
  wristbandWillBeRequested,
  onConfirm,
  onClose,
}: {
  participantName: string;
  categoryName: string | null;
  kitItemLabels: string[];
  hasKit: boolean;
  wristbandCode: string | null;
  wristbandWillBeRequested: boolean;
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirm() {
    setSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setSubmitting(false);
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={submitting ? undefined : onClose}>
      <div
        role="alertdialog"
        aria-modal="true"
        className="w-full max-w-sm rounded-t-3xl border border-cyan-500/30 bg-slate-950 p-5 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-slate-100">Confirmar entrega + check-in?</h3>
        <p className="mt-1 text-sm text-slate-400">
          Esta ação irá entregar os itens pendentes do kit e realizar o check-in deste ingresso.
        </p>

        <div className="mt-4 space-y-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-3 text-sm">
          <div>
            <p className="text-xs text-slate-500">Titular</p>
            <p className="text-slate-100">{participantName}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Ingresso</p>
            <p className="text-slate-100">{categoryName || "Ingresso único"}</p>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Itens a entregar</p>
            {kitItemLabels.length > 0 ? (
              <ul className="mt-2 space-y-1.5">
                {kitItemLabels.map((label, index) => (
                  <li key={`${label}-${index}`} className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-3 py-2 font-semibold text-cyan-100">
                    {label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-slate-100">
                {hasKit ? "Itens pendentes do kit deste ingresso" : "Este ingresso não possui kit."}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs text-slate-500">Pulseira</p>
            <p className="text-slate-100">
              {wristbandCode
                ? `Vinculada: ${wristbandCode}`
                : wristbandWillBeRequested
                  ? "Será solicitada antes da conclusão (obrigatória para este evento)."
                  : "Não vinculada (não obrigatória para este evento)."}
            </p>
          </div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={submitting} className="h-10 rounded-xl border border-slate-700 px-4 text-sm text-slate-300 disabled:opacity-50">
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={submitting}
            className="h-10 rounded-xl bg-cyan-500 px-4 text-sm font-semibold text-cyan-950 disabled:opacity-50"
          >
            {submitting ? "Confirmando..." : "Confirmar entrega + check-in"}
          </button>
        </div>
      </div>
    </div>
  );
}
