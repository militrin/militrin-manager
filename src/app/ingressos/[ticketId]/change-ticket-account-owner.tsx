"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { assignTicketAccountOwnerAction, searchTicketAccountOwnerContactsAction } from "@/app/cadastros/shared-email-actions";
import { TICKET_ACCOUNT_OWNER_REASON_OPTIONS } from "@/lib/account/shared-email-ownership";

type Candidate = {
  registration_contact_id: string;
  full_name: string;
  masked_email: string | null;
  public_pin: string | null;
  has_valid_auth: boolean;
};

export function ChangeTicketAccountOwnerCard(props: {
  ticketId: string;
  holderName: string;
  currentOwnerName: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [reasonCode, setReasonCode] = useState("");
  const [reasonText, setReasonText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const canSubmit = Boolean(selected && reasonCode && (reasonCode !== "other" || reasonText.trim()));

  if (!props.canManage) return null;

  return (
    <section className="rounded-3xl border border-violet-500/30 bg-violet-500/5 p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-200">Conta proprietária</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-xs text-slate-500">Titular atual</p>
          <p className="font-medium">{props.holderName}</p>
        </div>
        <div>
          <p className="text-xs text-slate-500">Conta proprietária atual</p>
          <p className="font-medium">{props.currentOwnerName}</p>
        </div>
      </div>
      <p className="mt-3 text-sm text-slate-400">Quem vê o ingresso em Minha Conta. O titular do ingresso não será alterado.</p>
      <button type="button" onClick={() => { setOpen(true); setMessage(null); }} className="mt-4 rounded-xl bg-violet-400 px-4 py-2 text-sm font-semibold text-slate-950">
        Alterar conta proprietária
      </button>
      {message && !open ? <p className="mt-3 text-sm text-emerald-200">{message}</p> : null}

      {open ? (
        <div role="dialog" aria-modal="true" aria-labelledby="change-owner-title" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-3xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <h2 id="change-owner-title" className="text-lg font-semibold">Alterar conta proprietária</h2>
              <button type="button" onClick={() => setOpen(false)} aria-label="Fechar" className="rounded-lg border border-slate-700 px-3 py-1">×</button>
            </div>
            <div className="mt-4 grid gap-3 text-sm">
              <p>Titular atual: <strong>{props.holderName}</strong></p>
              <p>Conta proprietária atual: <strong>{props.currentOwnerName}</strong></p>
            </div>
            <div className="mt-4 flex gap-2">
              <input
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Buscar por nome, e-mail ou PIN"
                className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"
              />
              <button
                type="button"
                disabled={pending || term.trim().length < 3}
                onClick={() => start(async () => {
                  const result = await searchTicketAccountOwnerContactsAction(props.ticketId, term);
                  setCandidates(result.candidates);
                  setSelected(null);
                  setMessage(result.message);
                })}
                className="rounded-xl border border-slate-700 px-3 py-2 text-sm"
              >
                Buscar
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {candidates.map((candidate) => (
                <button
                  type="button"
                  key={candidate.registration_contact_id}
                  onClick={() => setSelected(candidate)}
                  className={`block w-full rounded-xl border p-3 text-left ${selected?.registration_contact_id === candidate.registration_contact_id ? "border-violet-400" : "border-slate-800"}`}
                >
                  <strong>{candidate.full_name}</strong>
                  <span className="mt-1 block text-xs text-slate-400">
                    {candidate.masked_email ?? "E-mail indisponível"}
                    {candidate.public_pin ? ` · PIN ${candidate.public_pin}` : ""}
                    {candidate.has_valid_auth ? " · Conta ativa" : " · Conta ainda não ativada"}
                  </span>
                </button>
              ))}
            </div>
            {selected ? (
              <div className="mt-4 space-y-3 rounded-2xl bg-slate-950/70 p-4">
                <p className="text-sm">Nova conta proprietária: <strong>{selected.full_name}</strong></p>
                <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">O titular do ingresso não será alterado.</p>
                {selected.has_valid_auth ? (
                  <p className="text-sm text-emerald-200">Conta ativa. A propriedade será materializada imediatamente.</p>
                ) : (
                  <p className="text-sm text-amber-100">Conta ainda não ativada. Ownership será concluído após o primeiro acesso.</p>
                )}
                <label className="grid gap-1 text-sm">
                  <span>Motivo</span>
                  <select value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">
                    <option value="">Selecione</option>
                    {TICKET_ACCOUNT_OWNER_REASON_OPTIONS.map((option) => (
                      <option key={option.code} value={option.code}>{option.label}</option>
                    ))}
                  </select>
                </label>
                {reasonCode === "other" ? (
                  <label className="grid gap-1 text-sm">
                    <span>Descreva o motivo</span>
                    <input value={reasonText} onChange={(event) => setReasonText(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
                  </label>
                ) : null}
              </div>
            ) : null}
            {message ? <p className="mt-3 text-sm text-emerald-200">{message}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" disabled={pending} onClick={() => setOpen(false)} className="rounded-xl border border-slate-700 px-4 py-2">Cancelar</button>
              <button
                type="button"
                disabled={pending || !canSubmit}
                onClick={() => start(async () => {
                  if (!selected) return;
                  const result = await assignTicketAccountOwnerAction({
                    ticketId: props.ticketId,
                    ownerContactId: selected.registration_contact_id,
                    reasonCode,
                    reasonText,
                  });
                  setMessage(result.message);
                  if (result.success) {
                    setOpen(false);
                    router.refresh();
                  }
                })}
                className="rounded-xl bg-violet-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-40"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
