"use client";

import { useState, useTransition } from "react";
import { formatDateTimeBR } from "@/lib/utils/date";
import { resendInviteCenterAction } from "./actions";

export function InviteCenterResendButton({
  contactId,
  emailMasked,
  principalName,
  lastSentAt,
  statusLabel,
  ticketCount,
  actionLabel = "Reenviar convite",
}: {
  contactId: string;
  emailMasked: string;
  principalName: string;
  lastSentAt: string | null;
  statusLabel: string;
  ticketCount: number;
  actionLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await resendInviteCenterAction(contactId, "individual");
      setMessage(result.message);
      if (result.success) setOpen(false);
    });
  }

  return (
    <div id="reenviar">
      <button type="button" onClick={() => setOpen(true)} className="inline-flex h-10 items-center rounded-xl border border-amber-400/40 px-4 text-sm text-amber-100">
        {actionLabel}
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <h3 className="text-lg font-semibold text-white">{actionLabel} para {emailMasked}?</h3>
            <div className="mt-3 space-y-1 text-sm text-slate-300">
              <p>Pessoa/conta: {principalName}</p>
              <p>Último envio: {lastSentAt ? formatDateTimeBR(lastSentAt) : "—"}</p>
              <p>Status atual: {statusLabel}</p>
              <p>Ingressos cobertos: {ticketCount}</p>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-slate-700 px-3 py-2 text-sm">Cancelar</button>
              <button type="button" onClick={confirm} disabled={pending} className="rounded-xl bg-amber-400 px-3 py-2 text-sm font-semibold text-amber-950 disabled:opacity-50">
                {pending ? "Enviando..." : actionLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {message ? <p className="mt-2 text-sm text-slate-300">{message}</p> : null}
    </div>
  );
}
