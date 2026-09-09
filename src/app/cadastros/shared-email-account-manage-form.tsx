"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { assignSharedEmailAccountOwnerOrgAction } from "./shared-email-actions";
import { TICKET_ACCOUNT_OWNER_REASON_OPTIONS } from "@/lib/account/shared-email-ownership";
import { getStatusLabel } from "@/lib/status-labels";
import type { SharedEmailGroupView } from "@/lib/account/load-shared-email-group";

export function SharedEmailAccountManageForm({ group }: { group: SharedEmailGroupView }) {
  const router = useRouter();
  const [principalId, setPrincipalId] = useState(group.currentPrincipalId ?? "");
  const [reasonCode, setReasonCode] = useState(group.currentPrincipalId ? "shared_email" : "");
  const [reasonText, setReasonText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const selected = useMemo(
    () => group.people.find((person) => person.id === principalId) ?? null,
    [group.people, principalId],
  );
  const canSubmit = Boolean(principalId && reasonCode && (reasonCode !== "other" || reasonText.trim()));

  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-100">Conta principal</legend>
        <p className="text-sm text-slate-400">Escolha qual Pessoa terá a conta que vê estes ingressos. O titular de cada ingresso não muda.</p>
        <div className="space-y-2">
          {group.people.map((person) => (
            <label key={person.id} className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 ${principalId === person.id ? "border-violet-400 bg-violet-500/10" : "border-slate-800 bg-slate-950/40"}`}>
              <input type="radio" name="principal" className="mt-1" checked={principalId === person.id} onChange={() => setPrincipalId(person.id)} />
              <div className="min-w-0">
                <p className="font-medium">{person.name}{person.isPrincipal ? " · atual" : ""}</p>
                <p className="mt-1 text-xs text-slate-400">
                  PIN {person.pin ?? "—"} · {person.ticketCount} ingresso(s) · {person.hasValidAuth ? "Conta ativa" : "Conta ainda não ativada"}
                </p>
              </div>
            </label>
          ))}
        </div>
      </fieldset>

      {selected ? (
        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950/50 p-4">
          <h3 className="font-semibold">Esta conta terá acesso aos seguintes ingressos:</h3>
          {group.tickets.length === 0 ? (
            <p className="text-sm text-slate-400">Nenhum ingresso ativo neste grupo.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-2 pr-3">Evento</th>
                    <th className="py-2 pr-3">Código</th>
                    <th className="py-2 pr-3">Titular</th>
                    <th className="py-2 pr-3">Categoria</th>
                    <th className="py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {group.tickets.map((ticket) => (
                    <tr key={ticket.ticketId}>
                      <td className="py-2 pr-3">{ticket.eventName}</td>
                      <td className="py-2 pr-3 font-mono text-xs">#{ticket.code}</td>
                      <td className="py-2 pr-3">{ticket.holderName}</td>
                      <td className="py-2 pr-3">{ticket.categoryName}</td>
                      <td className="py-2">{getStatusLabel(ticket.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
            O titular do ingresso não será alterado.
          </p>
          {selected.hasValidAuth ? (
            <p className="text-sm text-emerald-200">Conta ativa. Ao confirmar, a propriedade será materializada imediatamente.</p>
          ) : (
            <p className="text-sm text-amber-100">Conta ainda não ativada. Ownership será concluído após o primeiro acesso.</p>
          )}
        </section>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
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

      {message ? <p className="text-sm text-emerald-200">{message}</p> : null}
      <button
        type="button"
        disabled={pending || !canSubmit}
        onClick={() => start(async () => {
          const result = await assignSharedEmailAccountOwnerOrgAction({
            primaryContactId: principalId,
            reasonCode,
            reasonText,
          });
          setMessage(result.message);
          if (result.success) router.push("/cadastros?shared_email=resolved");
        })}
        className="rounded-xl bg-violet-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-40"
      >
        Confirmar conta principal
      </button>
    </div>
  );
}
