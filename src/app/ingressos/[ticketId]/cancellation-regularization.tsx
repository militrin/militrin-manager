"use client";

import { useState, useTransition } from "react";
import { cancelTicketAction } from "@/app/ingressos/[ticketId]/editar/actions";

type Choice = "definitive" | "replacement";

type Props = {
  ticketId: string;
  status: string;
  replacementRequired: boolean | null;
  reasonText: string | null;
  canRegularize: boolean;
};

// Regulariza a INTENCAO de um cancelamento administrativo legado (
// cancellation_replacement_required=NULL, coluna adicionada por
// 20260924000000 -- ticket cancelado ANTES dela existir nunca teve essa
// decisao registrada). Reusa cancelTicketAction/owner_cancel_ticket sem
// nenhuma mudanca de backend: a RPC ja reclassifica um ticket ja cancelado
// (branch v_was_cancelled), ja audita em audit_logs
// ('ticket_cancellation_reclassified', ator+antes+depois), e ja aplica a
// MESMA regra de autorizacao (organizacao + Owner OU orders.cancel) --
// so nunca existia um caminho de UI ate aqui pra chamar essa reclassificacao
// quando o ticket ja estava cancelado (a secao "Cancelar ingresso" de
// /editar fica inteiramente desabilitada nesse estado).
export function TicketCancellationRegularization(props: Props) {
  const [replacementRequired, setReplacementRequired] = useState(props.replacementRequired);
  const [confirmChoice, setConfirmChoice] = useState<Choice | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (props.status !== "cancelled") return null;

  function submit(choice: Choice) {
    const required = choice === "replacement";
    start(async () => {
      const reason = props.reasonText?.trim() || "Classificação da intenção de substituição registrada via regularização administrativa.";
      const result = await cancelTicketAction(props.ticketId, reason, true, required);
      setMessage(result.message);
      setConfirmChoice(null);
      if (result.success) setReplacementRequired(required);
    });
  }

  return (
    <div id="regularizacao-cancelamento" className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <h2 className="font-semibold text-amber-100">Regularização do cancelamento</h2>

      {replacementRequired === null ? (
        props.canRegularize ? (
          <>
            <p className="text-sm text-slate-300">
              Este ingresso foi cancelado antes de o sistema registrar se deveria existir um substituto. Informe como este cancelamento deve ser tratado.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmChoice("definitive")}
                className="rounded-lg border border-emerald-500/40 px-3 py-2 text-sm text-emerald-200 disabled:opacity-50"
              >
                Cancelamento definitivo — não haverá ingresso substituto
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => setConfirmChoice("replacement")}
                className="rounded-lg border border-amber-500/40 px-3 py-2 text-sm text-amber-200 disabled:opacity-50"
              >
                Exige substituição — outro ingresso deverá ser emitido
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-400">
            Este ingresso foi cancelado antes de o sistema registrar se deveria existir um substituto e requer regularização manual por um administrador autorizado.
          </p>
        )
      ) : replacementRequired ? (
        <div className="space-y-2">
          <p className="text-sm text-amber-200">
            <strong>Substituição necessária.</strong> Aguardando ingresso substituto.
          </p>
          {props.canRegularize ? (
            <button type="button" disabled={pending} onClick={() => setConfirmChoice("definitive")} className="text-xs text-slate-400 underline disabled:opacity-50">
              Alterar classificação
            </button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-emerald-200">
            <strong>Cancelamento definitivo.</strong> Não exige ingresso substituto.
          </p>
          {props.canRegularize ? (
            <button type="button" disabled={pending} onClick={() => setConfirmChoice("replacement")} className="text-xs text-slate-400 underline disabled:opacity-50">
              Alterar classificação
            </button>
          ) : null}
        </div>
      )}

      {confirmChoice ? (
        <div role="dialog" aria-modal="true" aria-labelledby="regularizacao-confirm-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-lg space-y-4 rounded-xl border border-slate-700 bg-slate-950 p-5 shadow-2xl">
            <h2 id="regularizacao-confirm-title" className="text-lg font-semibold text-slate-100">
              {confirmChoice === "definitive" ? "Confirmar cancelamento definitivo?" : "Confirmar necessidade de substituição?"}
            </h2>
            <p className="text-sm text-slate-300">
              {confirmChoice === "definitive"
                ? "Este ingresso permanecerá cancelado e o sistema deixará de exigir a emissão de um substituto."
                : "O ingresso permanecerá cancelado e o sistema continuará exigindo um ingresso substituto."}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" disabled={pending} onClick={() => setConfirmChoice(null)} className="rounded-lg border border-slate-700 px-3 py-2">
                Cancelar
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => submit(confirmChoice)}
                className="rounded-lg bg-amber-500 px-3 py-2 font-semibold text-slate-950 disabled:opacity-50"
              >
                {pending ? "Confirmando..." : "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {message ? <p role="status" className="text-sm text-slate-300">{message}</p> : null}
    </div>
  );
}
