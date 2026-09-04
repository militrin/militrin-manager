"use client";

import { useState, useTransition } from "react";
import { inviteCadastroFirstAccessAction } from "./actions";

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
  } | null;
};

function formatExpiry(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("pt-BR");
}

export function InviteAccountButton({ contactId, canInvite, inviteStatus, reason, inviteRecord }: InviteAccountButtonProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const expiryLabel = formatExpiry(inviteRecord?.expiresAt ?? null);

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
          {expiryLabel ? <p className="mt-1">Validade interna: {expiryLabel}. Se venceu, reenvie para o e-mail cadastrado gerar um novo link Auth.</p> : <p className="mt-1">Validade: definida pelo provedor de autenticação (7 dias no cadastro interno).</p>}
          <p className="mt-1 text-slate-400">O link de primeiro acesso é enviado por e-mail pelo Supabase Auth. Esta tela não copia nem exibe token.</p>
        </div>
      ) : null}
      {canInvite ? <button type="button" onClick={submit} disabled={isPending} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500 disabled:opacity-50">
        {isPending ? "Enviando..." : inviteStatus === "pending" ? "Reenviar convite" : "Enviar convite para criar conta"}
      </button> : null}
      {!canInvite ? <p className="text-xs text-amber-300">{reason}</p> : null}
      {message ? <p className="text-xs text-slate-400">{message}</p> : null}
    </div>
  );
}
