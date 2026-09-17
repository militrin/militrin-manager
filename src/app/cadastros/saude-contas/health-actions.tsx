"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AccountHealthAction, AccountHealthState } from "@/lib/account/account-health";
import {
  reanalyzeAccountHealthCaseAction,
  resendAccountHealthConfirmationAction,
  sendAccountHealthAccessAction,
  sendAccountHealthInviteAction,
} from "./actions";

const buttonClass = "inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold disabled:opacity-50";

export function AccountHealthCaseActions({
  caseId,
  state,
  actions,
  canAct,
}: {
  caseId: string;
  state: AccountHealthState;
  actions: AccountHealthAction[];
  canAct: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(task: () => Promise<{ success: boolean; message: string }>) {
    setMessage(null);
    startTransition(async () => {
      const result = await task();
      setMessage(result.message);
      if (result.success) router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {canAct && actions.includes("resend_confirmation") ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(() => resendAccountHealthConfirmationAction(caseId))}
            className={`${buttonClass} border border-emerald-500/40 bg-emerald-500/10 text-emerald-100`}
          >
            {isPending ? "Enviando..." : "Reenviar confirmação"}
          </button>
        ) : null}
        {canAct && actions.includes("send_invite") ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(() => sendAccountHealthInviteAction(caseId))}
            className={`${buttonClass} border border-emerald-500/40 bg-emerald-500/10 text-emerald-100`}
          >
            {isPending ? "Enviando..." : "Enviar convite"}
          </button>
        ) : null}
        {canAct && actions.includes("send_access") ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(() => sendAccountHealthAccessAction(caseId))}
            className={`${buttonClass} border border-emerald-500/40 bg-emerald-500/10 text-emerald-100`}
          >
            {isPending ? "Enviando..." : "Enviar acesso"}
          </button>
        ) : null}
        <button
          type="button"
          disabled={isPending}
          onClick={() => run(() => reanalyzeAccountHealthCaseAction(caseId))}
          className={`${buttonClass} border border-slate-600 text-slate-100`}
        >
          {isPending ? "Atualizando..." : "Reanalisar"}
        </button>
      </div>
      {state === "attention" ? (
        <p className="text-sm text-amber-100">Este caso requer análise administrativa.</p>
      ) : null}
      {state === "possible_orphan" ? (
        <p className="text-sm text-slate-300">Possível conta sem vínculo operacional. Nesta versão não há exclusão, mesclagem nem consolidação automática.</p>
      ) : null}
      {message ? <p className="text-sm text-slate-300" data-account-health-feedback="true">{message}</p> : null}
    </div>
  );
}
