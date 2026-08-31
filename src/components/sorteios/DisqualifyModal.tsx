"use client";

import { useState } from "react";
import { DISQUALIFICATION_REASONS, type DisqualificationReason, type ParticipationEntry } from "./types";

type DisqualifyModalProps = {
  open: boolean;
  winner: ParticipationEntry | null;
  onClose: () => void;
  onConfirm: (reason: DisqualificationReason, reasonLabel: string, otherDetail?: string) => void;
};

export function DisqualifyModal({ open, winner, onClose, onConfirm }: DisqualifyModalProps) {
  const [reason, setReason] = useState<DisqualificationReason>("not_following");
  const [otherDetail, setOtherDetail] = useState("");
  const [touched, setTouched] = useState(false);

  if (!open || !winner) return null;

  const isOther = reason === "other";
  const otherInvalid = isOther && otherDetail.trim().length === 0;

  function handleConfirm() {
    setTouched(true);
    if (otherInvalid) return;
    const label = DISQUALIFICATION_REASONS.find((r) => r.value === reason)?.label ?? reason;
    onConfirm(reason, label, isOther ? otherDetail.trim() : undefined);
    setReason("not_following");
    setOtherDetail("");
    setTouched(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <h3 className="text-lg font-semibold text-white">Desclassificar participante?</h3>
        <p className="mt-1 text-sm text-slate-300">
          @{winner.username} será removido(a) deste sorteio e um novo comentário será sorteado.
        </p>

        <div className="mt-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Motivo da desclassificação</p>
          {DISQUALIFICATION_REASONS.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition ${
                reason === option.value
                  ? "border-emerald-400/60 bg-emerald-500/10 text-emerald-100"
                  : "border-slate-700 bg-slate-950/50 text-slate-300 hover:border-slate-600"
              }`}
            >
              <input
                type="radio"
                name="disqualify-reason"
                value={option.value}
                checked={reason === option.value}
                onChange={() => setReason(option.value)}
                className="accent-emerald-400"
              />
              {option.label}
            </label>
          ))}

          {isOther ? (
            <div>
              <textarea
                value={otherDetail}
                onChange={(e) => setOtherDetail(e.target.value)}
                placeholder="Descreva o motivo (obrigatório)"
                rows={3}
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-400"
              />
              {touched && otherInvalid ? <p className="mt-1 text-xs text-rose-300">Descreva o motivo para continuar.</p> : null}
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="rounded-xl bg-rose-500 px-3 py-2 text-xs font-semibold text-white hover:bg-rose-400"
          >
            DESCLASSIFICAR E REALIZAR NOVO SORTEIO
          </button>
        </div>
      </div>
    </div>
  );
}
