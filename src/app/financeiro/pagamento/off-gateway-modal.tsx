"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { datetimeLocalInEventTimeZoneToIso, formatDateTimeBR } from "@/lib/utils/date";
import { regularizeOffGatewayPaymentAction } from "./actions";

type OffGatewayModalProps = {
  paymentId: string;
  orderLabel: string;
  buyerName: string;
  replace: boolean;
};

function money(value: number) {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function parseAmount(raw: string) {
  const normalized = String(raw ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

export function OffGatewayPaymentModal(props: OffGatewayModalProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [amountReceived, setAmountReceived] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [destinationNote, setDestinationNote] = useState("");
  const [replace, setReplace] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();

  const amount = parseAmount(amountReceived);
  const receivedAtIso = datetimeLocalInEventTimeZoneToIso(receivedAt);
  const canContinue = Boolean(amount && amount > 0 && receivedAtIso && reason.trim()) && !pending;

  const summary = useMemo(() => ({
    orderLabel: props.orderLabel,
    buyerName: props.buyerName,
    amountLabel: amount && amount > 0 ? money(amount) : "—",
    receivedAtLabel: receivedAtIso ? `${formatDateTimeBR(receivedAtIso) ?? receivedAt} America/Sao_Paulo` : "—",
    destinationNote: destinationNote.trim() || "—",
  }), [amount, destinationNote, props.buyerName, props.orderLabel, receivedAt, receivedAtIso]);

  function close() {
    if (pending) return;
    setOpen(false);
    setStep("form");
    setMessage(null);
    setSuccess(false);
  }

  function submit() {
    startTransition(async () => {
      const result = await regularizeOffGatewayPaymentAction({
        paymentId: props.paymentId,
        method: "pix",
        amountReceived,
        receivedAt,
        reason,
        reference,
        destinationNote,
        replace: props.replace ? replace : false,
      });
      setMessage(result.message);
      if (result.success) {
        setSuccess(true);
        router.refresh();
      }
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-10 items-center rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
      >
        {props.replace ? "Substituir pagamento fora do gateway" : "Registrar pagamento fora do gateway"}
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <h3 className="text-lg font-semibold text-white">
              {step === "confirm" ? "Confirmar pagamento fora do gateway" : "Registrar pagamento fora do gateway"}
            </h3>
            <p className="mt-1 text-sm text-slate-300">
              Use esta opção somente quando o pagamento foi recebido diretamente, sem processamento pelo gateway integrado.
            </p>

            {success ? (
              <div className="mt-4 space-y-4">
                <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-100" role="status">
                  {message}
                </p>
                <div className="flex justify-end">
                  <button type="button" onClick={close} className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-slate-950">
                    Fechar
                  </button>
                </div>
              </div>
            ) : step === "form" ? (
              <div className="mt-4 space-y-3">
                <label className="block text-sm text-slate-200">
                  Forma de pagamento
                  <select disabled className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm">
                    <option value="pix">PIX</option>
                  </select>
                </label>
                <label className="block text-sm text-slate-200">
                  Valor recebido
                  <input
                    value={amountReceived}
                    onChange={(event) => setAmountReceived(event.target.value)}
                    inputMode="decimal"
                    placeholder="215,00"
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-sm text-slate-200">
                  Data/hora do recebimento
                  <input
                    type="datetime-local"
                    value={receivedAt}
                    onChange={(event) => setReceivedAt(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-sm text-slate-200">
                  Motivo/observação
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    rows={3}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-sm text-slate-200">
                  Destino/observação (opcional)
                  <input
                    value={destinationNote}
                    onChange={(event) => setDestinationNote(event.target.value)}
                    placeholder="Recebido em outra conta"
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  />
                </label>
                <label className="block text-sm text-slate-200">
                  Referência/comprovante (opcional)
                  <input
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
                  />
                </label>
                {props.replace ? (
                  <label className="flex items-start gap-2 text-sm text-amber-100">
                    <input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} className="mt-1" />
                    <span>Substituir a regularização já existente. Sem este passo o sistema não sobrescreve silenciosamente.</span>
                  </label>
                ) : null}
                {message ? <p className="text-sm text-amber-100" role="status">{message}</p> : null}
                <div className="mt-5 flex justify-end gap-2">
                  <button type="button" disabled={pending} onClick={close} className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 disabled:opacity-50">
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={!canContinue || (props.replace && !replace)}
                    onClick={() => setStep("confirm")}
                    className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50"
                  >
                    Continuar
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
                  <p className="font-semibold text-emerald-100">Pagamento fora do gateway</p>
                  <dl className="mt-3 grid gap-2 sm:grid-cols-2">
                    <Field label="Pedido" value={summary.orderLabel} />
                    <Field label="Cliente" value={summary.buyerName} />
                    <Field label="Método" value="PIX" />
                    <Field label="Natureza" value="Fora do gateway" />
                    <Field label="Valor recebido" value={summary.amountLabel} />
                    <Field label="Recebido em" value={summary.receivedAtLabel} />
                    <Field label="Gateway" value="Nenhum" />
                    <Field label="Destino/observação" value={summary.destinationNote} />
                  </dl>
                </div>
                {message ? <p className="text-sm text-amber-100" role="status">{message}</p> : null}
                <div className="flex justify-end gap-2">
                  <button type="button" disabled={pending} onClick={() => setStep("form")} className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200 disabled:opacity-50">
                    Voltar
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={submit}
                    className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-50"
                  >
                    {pending ? "Registrando..." : "Confirmar pagamento recebido"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-emerald-500/20 bg-slate-950/60 px-3 py-2">
      <dt className="text-[11px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="font-medium text-slate-100">{value || "—"}</dd>
    </div>
  );
}
