"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ADMIN_REFUND_REASON_CODES,
  ADMIN_REFUND_REASON_LABELS,
  type AdminRefundReasonCode,
} from "@/lib/payments/admin-refund-eligibility";
import type { AdminRefundTicketView } from "@/lib/payments/admin-refund-tickets";
import { requestAdminPaymentRefundAction } from "./actions";

type AdminRefundModalProps = {
  paymentId: string;
  orderLabel: string;
  amountLabel: string;
  methodLabel: string;
  environmentLabel: string;
  statusLabel: string;
  gatewayPaymentId: string;
  confirmPhrase: string;
  defaultCancelTickets: boolean;
  tickets: AdminRefundTicketView[];
  mode?: "execute" | "reconcile";
  triggerLabel: string;
};

const blockerLabel = {
  used: "Ingresso usado — não cancela cegamente",
  checkin: "Check-in realizado — não cancela cegamente",
  kit_delivered: "Kit entregue — estoque físico não volta automaticamente",
} as const;

export function AdminRefundPaymentModal(props: AdminRefundModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState<AdminRefundReasonCode>("customer_request");
  const [reasonText, setReasonText] = useState("");
  const [cancelTickets, setCancelTickets] = useState(props.defaultCancelTickets);
  const [confirmPhrase, setConfirmPhrase] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reasonNeedsText = reasonCode === "other";
  const confirmOk = confirmPhrase.trim() === props.confirmPhrase;
  const canSubmit = confirmOk && (!reasonNeedsText || reasonText.trim().length > 0) && !pending;

  const ticketSummary = useMemo(
    () => props.tickets.map((ticket) => `${ticket.code} · ${ticket.holderName} · ${ticket.status}`).join("\n"),
    [props.tickets],
  );

  function close() {
    if (pending) return;
    setOpen(false);
    setMessage(null);
    setConfirmPhrase("");
  }

  function submit() {
    startTransition(async () => {
      const result = await requestAdminPaymentRefundAction({
        paymentId: props.paymentId,
        reasonCode,
        reasonText: reasonNeedsText ? reasonText : null,
        cancelTickets,
        confirmPhrase,
        mode: props.mode ?? "execute",
      });
      setMessage(result.message);
      if (result.success || result.status === "pending" || result.status === "uncertain" || result.status === "completed") {
        router.refresh();
      }
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-10 items-center rounded-xl bg-rose-500 px-4 text-sm font-semibold text-white hover:bg-rose-400"
      >
        {props.triggerLabel}
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <h3 className="text-lg font-semibold text-white">Estornar pagamento</h3>
            <p className="mt-1 text-sm text-slate-300">Estornar o pagamento não cancela ingressos automaticamente.</p>

            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
              <Field label="Pedido" value={props.orderLabel} />
              <Field label="Valor" value={props.amountLabel} />
              <Field label="Método" value={props.methodLabel} />
              <Field label="Ambiente" value={props.environmentLabel} />
              <Field label="Status" value={props.statusLabel} />
              <Field label="Gateway id" value={props.gatewayPaymentId} />
            </dl>

            <section className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
              <h4 className="text-sm font-semibold text-slate-100">Ingressos associados</h4>
              {!props.tickets.length ? (
                <p className="mt-2 text-sm text-slate-400">Nenhum ingresso vinculado a este pagamento.</p>
              ) : (
                <ul className="mt-2 space-y-2 text-sm">
                  {props.tickets.map((ticket) => (
                    <li key={ticket.id} className="rounded-lg border border-slate-800 px-3 py-2">
                      <p className="font-medium text-slate-100">{ticket.code} · {ticket.holderName}</p>
                      <p className="text-xs text-slate-400">
                        Status: {ticket.status}
                        {ticket.usedAt ? " · check-in" : ""}
                        {ticket.kitStatus === "delivered" ? " · kit entregue" : ticket.kitStatus === "pending" ? " · kit não entregue" : ""}
                      </p>
                      {ticket.blocker ? (
                        <p className="mt-1 text-xs text-amber-200">{blockerLabel[ticket.blocker]}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              <pre className="sr-only">{ticketSummary}</pre>
            </section>

            <label className="mt-4 block text-sm text-slate-200">
              Motivo
              <select
                value={reasonCode}
                onChange={(event) => setReasonCode(event.target.value as AdminRefundReasonCode)}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              >
                {ADMIN_REFUND_REASON_CODES.map((code) => (
                  <option key={code} value={code}>{ADMIN_REFUND_REASON_LABELS[code]}</option>
                ))}
              </select>
            </label>

            {reasonNeedsText ? (
              <label className="mt-3 block text-sm text-slate-200">
                Descreva o motivo
                <textarea
                  value={reasonText}
                  onChange={(event) => setReasonText(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  rows={3}
                />
              </label>
            ) : null}

            <label className="mt-4 flex items-start gap-2 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={cancelTickets}
                onChange={(event) => setCancelTickets(event.target.checked)}
                className="mt-1"
              />
              <span>
                Cancelar ingressos ativos vinculados
                {props.defaultCancelTickets ? " (marcado por padrão porque há ingressos canceláveis)" : ""}
              </span>
            </label>

            <label className="mt-4 block text-sm text-slate-200">
              Confirmação forte
              <input
                value={confirmPhrase}
                onChange={(event) => setConfirmPhrase(event.target.value)}
                placeholder={props.confirmPhrase}
                className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              />
              <span className="mt-1 block text-xs text-slate-400">Digite exatamente: {props.confirmPhrase}</span>
            </label>

            {message ? <p className="mt-3 text-sm text-amber-100" role="status">{message}</p> : null}

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={pending} onClick={close} className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 disabled:opacity-50">
                Cancelar
              </button>
              <button
                type="button"
                disabled={!canSubmit}
                onClick={submit}
                className="rounded-xl bg-rose-500 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
              >
                {pending ? "Enviando..." : props.mode === "reconcile" ? "Conciliar estorno" : "Confirmar estorno"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/80 px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-100">{value || "—"}</dd>
    </div>
  );
}
