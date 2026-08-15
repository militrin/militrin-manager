"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AlertTriangle, ChevronLeft, X } from "lucide-react";
import { AdminStatusBadge } from "@/components/admin";
import {
  updateParticipantPaymentStatusAction,
} from "./actions";
import { PAYMENT_STATUS_LABELS, type UpdatePaymentStatusInput } from "./payment-status.types";

// ── tipos ──────────────────────────────────────────────────────────────────

type Props = {
  participantId: string;
  participantName: string;
  paymentId: string;
  currentStatus: string;
  canConfirmPayment: boolean;
  canRefund: boolean;
  triggerLabel?: string;
  initialStatus?: string;
  triggerClassName?: string;
};

type Stage = "closed" | "selecting" | "confirming" | "submitting" | "success" | "error";

// ── opções de status disponíveis por permissão ─────────────────────────────

const CONFIRM_OPTIONS = ["pending", "paid", "expired", "cancelled"] as const;
const REFUND_OPTIONS = ["refunded"] as const;

const STATUS_DESCRIPTIONS: Record<string, string> = {
  pending: "O pagamento voltará a ficar aguardando confirmação.",
  paid: "O pagamento será marcado como confirmado e o ingresso será emitido.",
  expired: "O pagamento será marcado como expirado.",
  cancelled: "O pagamento será cancelado. Bloqueado se já houver ingresso usado ou kit entregue.",
  refunded: "Alteração administrativa de status. Não executa estorno no gateway de pagamento.",
};

// ── utilitários ────────────────────────────────────────────────────────────

function StatusPill({ status }: { status: string }) {
  return <AdminStatusBadge status={status} />;
}

// ── componente principal ───────────────────────────────────────────────────

export function PaymentStatusDialog({
  participantId,
  participantName,
  paymentId,
  currentStatus,
  canConfirmPayment,
  canRefund,
  triggerLabel,
  initialStatus,
  triggerClassName,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [stage, setStage] = useState<Stage>("closed");
  const [selectedStatus, setSelectedStatus] = useState("");
  const [reason, setReason] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const canEdit = canConfirmPayment || canRefund;

  const availableOptions = [
    ...(canConfirmPayment ? CONFIRM_OPTIONS : []),
    ...(canRefund ? REFUND_OPTIONS : []),
  ].filter((s) => s !== currentStatus);

  // ── handlers ──────────────────────────────────────────────────────────

  function open() {
    setSelectedStatus(initialStatus ?? "");
    setReason("");
    if (!paymentId) {
      setErrorMsg("Não foi possível localizar o pagamento pendente deste participante.");
      setStage("error");
      return;
    }
    setErrorMsg("");
    setStage("selecting");
  }

  function close() {
    setStage("closed");
    setErrorMsg("");
  }

  function goToConfirm() {
    if (!selectedStatus) { setErrorMsg("Selecione um novo status."); return; }
    if (reason.trim().length < 3) { setErrorMsg("Motivo obrigatório (mínimo 3 caracteres)."); return; }
    setErrorMsg("");
    setStage("confirming");
  }

  function goBack() {
    setErrorMsg("");
    setStage("selecting");
  }

  function confirm() {
    if (isPending) return;
    setStage("submitting");
    setErrorMsg("");

    const input: UpdatePaymentStatusInput = {
      participantId,
      paymentId,
      expectedCurrentStatus: currentStatus,
      newStatus: selectedStatus,
      reason: reason.trim(),
    };

    startTransition(async () => {
      const result = await updateParticipantPaymentStatusAction(input);
      if (result.success) {
        setSuccessMsg(result.message ?? "Alteração realizada.");
        setStage("success");
        router.refresh();
        setTimeout(() => { setStage("closed"); setSuccessMsg(""); }, 2500);
      } else {
        setErrorMsg(result.message ?? "Erro ao alterar status.");
        setStage("error");
      }
    });
  }

  // ── render badge (fora do modal) ──────────────────────────────────────

  if (!canEdit) {
    return <AdminStatusBadge status={currentStatus} />;
  }

  return (
    <>
      {/* Badge clicável */}
      <button
        type="button"
        onClick={open}
        title="Clique para alterar o status"
        className={triggerClassName ?? "group relative inline-flex items-center"}
      >
        {triggerLabel ?? <AdminStatusBadge status={currentStatus} />}
        {!triggerLabel ? (
          <span className="absolute -right-1 -top-1 hidden h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-700 text-[8px] text-slate-300 group-hover:flex">
            ✎
          </span>
        ) : null}
      </button>

      {/* Modal overlay */}
      {stage !== "closed" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={stage === "submitting" ? undefined : close}
          />

          {/* Dialog */}
          <div className="relative z-10 w-full max-w-md rounded-3xl border border-slate-700/80 bg-slate-900 shadow-2xl shadow-black/40">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
              <h2 className="text-base font-semibold text-slate-100">Alterar status do pagamento</h2>
              {stage !== "submitting" && (
                <button type="button" onClick={close} className="text-slate-500 hover:text-slate-200 transition">
                  <X size={18} />
                </button>
              )}
            </div>

            {/* Participante */}
            <div className="border-b border-slate-800/60 px-6 py-3 text-sm">
              <span className="text-slate-500">Participante:</span>{" "}
              <span className="font-medium text-slate-200">{participantName}</span>
            </div>

            {/* ── Stage 1: seleção ──────────────────────────────────── */}
            {(stage === "selecting" || stage === "error") && (
              <div className="space-y-4 px-6 py-5">
                <div className="flex items-center gap-3 text-sm">
                  <span className="text-slate-500">Status atual:</span>
                  <StatusPill status={currentStatus} />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-slate-500">
                    Novo status
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {availableOptions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => { setSelectedStatus(s); setErrorMsg(""); }}
                        className={`rounded-xl border px-3 py-2.5 text-left text-sm transition ${
                          selectedStatus === s
                            ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-200"
                            : "border-slate-700 text-slate-300 hover:border-slate-500"
                        }`}
                      >
                        {PAYMENT_STATUS_LABELS[s] ?? s}
                      </button>
                    ))}
                  </div>
                  {selectedStatus && (
                    <p className="mt-2 text-xs text-slate-500 italic">
                      {STATUS_DESCRIPTIONS[selectedStatus]}
                    </p>
                  )}
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-slate-500">
                    Motivo <span className="text-rose-400">*</span>
                  </label>
                  <textarea
                    value={reason}
                    onChange={(e) => { setReason(e.target.value); setErrorMsg(""); }}
                    rows={2}
                    placeholder="Descreva o motivo da alteração..."
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-200 placeholder-slate-500 focus:border-emerald-500 focus:outline-none resize-none"
                  />
                </div>

                {errorMsg && (
                  <p className="flex items-center gap-2 text-xs text-rose-400">
                    <AlertTriangle size={13} /> {errorMsg}
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={close} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-500 transition">
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={goToConfirm}
                    disabled={!selectedStatus || !paymentId}
                    className="rounded-xl bg-emerald-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    Continuar
                  </button>
                </div>
              </div>
            )}

            {/* ── Stage 2: confirmação ──────────────────────────────── */}
            {stage === "confirming" && (
              <div className="space-y-4 px-6 py-5">
                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 px-4 py-3 text-sm text-amber-200">
                  <p className="font-medium">Confirme a alteração</p>
                  <p className="mt-0.5 text-xs text-amber-300/80">Esta ação ficará registrada no histórico de auditoria.</p>
                </div>

                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Status atual</span>
                    <StatusPill status={currentStatus} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Novo status</span>
                    <StatusPill status={selectedStatus} />
                  </div>
                  <div className="flex items-start justify-between gap-4">
                    <span className="shrink-0 text-slate-500">Motivo</span>
                    <span className="text-right text-slate-300">{reason}</span>
                  </div>
                </div>

                {selectedStatus === "refunded" && (
                  <p className="rounded-xl border border-slate-700 bg-slate-800/50 px-3 py-2 text-xs text-slate-400">
                    ⚠ Alteração administrativa de status apenas. Nenhum estorno será processado no gateway de pagamento.
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={goBack} className="flex items-center gap-1.5 rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-500 transition">
                    <ChevronLeft size={14} /> Voltar
                  </button>
                  <button
                    type="button"
                    onClick={confirm}
                    className="rounded-xl bg-emerald-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 transition"
                  >
                    Confirmar alteração
                  </button>
                </div>
              </div>
            )}

            {/* ── Stage: submitting ─────────────────────────────────── */}
            {stage === "submitting" && (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-10">
                <svg className="h-8 w-8 animate-spin text-emerald-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                <p className="text-sm text-slate-400">Processando alteração...</p>
              </div>
            )}

            {/* ── Stage: success ────────────────────────────────────── */}
            {stage === "success" && (
              <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="text-sm font-medium text-emerald-300">{successMsg}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
