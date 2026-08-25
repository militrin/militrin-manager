"use client";

import { useState, useTransition } from "react";
import { inviteCadastroFirstAccessAction } from "./actions";

// Reusa o fluxo de convite de primeiro acesso existente. A elegibilidade e o
// estado chegam do backend canonico da Pessoa; o React nao reimplementa regras.
type InviteAccountButtonProps = {
  contactId: string;
  canInvite: boolean;
  inviteStatus: "available" | "pending" | "linked" | "blocked" | "forbidden";
  reason: string;
};

export function InviteAccountButton({ contactId, canInvite, inviteStatus, reason }: InviteAccountButtonProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setMessage(null);
    startTransition(async () => {
      const result = await inviteCadastroFirstAccessAction(contactId, "contact");
      setMessage(result.message);
    });
  }

  return (
    <div className="space-y-2">
      {canInvite ? <button type="button" onClick={submit} disabled={isPending} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500 disabled:opacity-50">
        {isPending ? "Enviando..." : inviteStatus === "pending" ? "Reenviar convite" : "Enviar convite para criar conta"}
      </button> : null}
      {!canInvite ? <p className="text-xs text-amber-300">{reason}</p> : null}
      {message ? <p className="text-xs text-slate-400">{message}</p> : null}
    </div>
  );
}
