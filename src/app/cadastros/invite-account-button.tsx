"use client";

import { useState, useTransition } from "react";
import { inviteCadastroFirstAccessAction } from "./actions";

// Reusa o fluxo de convite de primeiro acesso ja existente
// (inviteCadastroFirstAccessAction / check_participant_account_invite_eligibility)
// -- so oferece o botao quando ha pelo menos um participante elegivel pra
// ancorar o convite; nenhum sistema de convite novo criado pra Cadastros.
export function InviteAccountButton({ participantId }: { participantId: string }) {
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setMessage(null);
    startTransition(async () => {
      const result = await inviteCadastroFirstAccessAction(participantId);
      setMessage(result.message);
    });
  }

  return (
    <div className="space-y-2">
      <button type="button" onClick={submit} disabled={isPending} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:border-slate-500 disabled:opacity-50">
        {isPending ? "Enviando..." : "Enviar convite para criar conta"}
      </button>
      {message ? <p className="text-xs text-slate-400">{message}</p> : null}
    </div>
  );
}
