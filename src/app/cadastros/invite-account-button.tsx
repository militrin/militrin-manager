"use client";

import { useState, useTransition } from "react";
import { inviteCadastroFirstAccessAction } from "./actions";
import { firstAccessInviteAdminCopy } from "@/lib/account/first-access-invite-copy";

// Reusa o fluxo de convite de primeiro acesso existente. A elegibilidade e o
// estado chegam do backend canonico da Pessoa; o React nao reimplementa regras.
// O token de Auth nao e armazenado nem copiado nesta tela.
type InviteAccountButtonProps = {
  contactId: string;
  canInvite: boolean;
  inviteStatus: "available" | "pending" | "linked" | "blocked" | "forbidden";
  reason: string;
  inviteRecord?: {
    status: string;
    expiresAt: string | null;
    authLinkExpiresAt?: string | null;
  } | null;
  createNewAuth?: boolean;
};

export function InviteAccountButton({ contactId, canInvite, inviteStatus, reason, inviteRecord, createNewAuth = true }: InviteAccountButtonProps) {
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
      {inviteRecord ? (
        <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-xs text-slate-300">
          <p>Status do convite: <strong>{inviteRecord.status}</strong></p>
          <p className="mt-1">{firstAccessInviteAdminCopy({
            inviteExpiresAt: inviteRecord.expiresAt,
            authLinkExpiresAt: inviteRecord.authLinkExpiresAt,
          })}</p>
          <p className="mt-1 text-slate-400">O link de primeiro acesso é enviado por e-mail pelo Supabase Auth. Esta tela não copia nem exibe token.</p>
        </div>
      ) : null}
      {canInvite ? <button type="button" onClick={submit} disabled={isPending} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500 disabled:opacity-50">
        {isPending ? "Enviando..." : inviteStatus === "pending" ? "Reenviar convite" : createNewAuth ? "Enviar convite para criar conta" : "Enviar acesso para a conta existente"}
      </button> : null}
      {!canInvite ? <p className="text-xs text-amber-300">{reason}</p> : null}
      {message ? <p className="text-xs text-slate-400">{message}</p> : null}
    </div>
  );
}
