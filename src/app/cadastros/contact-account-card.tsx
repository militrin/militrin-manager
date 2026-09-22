"use client";

import { useState, useTransition } from "react";
import { resendCadastroSignupConfirmationAction } from "./actions";
import { InviteAccountButton } from "./invite-account-button";
import { adminAttentionCopy, contactAccountStateView, linkedOtherAccountLabel, type ContactAccountState } from "@/lib/account/contact-account-state";
import { PENDING_CONFIRMATION_ADMIN_COPY } from "@/lib/account/first-access-invite-copy";

type ContactAccountCardProps = {
  contactId: string;
  email: string | null;
  state: ContactAccountState;
  reasonCode: string | null;
  reason: string;
  canInvite: boolean;
  canResendConfirmation: boolean;
  linkedAccountOwnerName?: string | null;
  inviteRecord?: {
    status: string;
    expiresAt: string | null;
    authLinkExpiresAt?: string | null;
  } | null;
};

export function ContactAccountCard({
  contactId,
  email,
  state,
  reasonCode,
  reason,
  canInvite,
  canResendConfirmation,
  linkedAccountOwnerName,
  inviteRecord,
}: ContactAccountCardProps) {
  const view = contactAccountStateView(state);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function resendConfirmation() {
    setMessage(null);
    startTransition(async () => {
      const result = await resendCadastroSignupConfirmationAction(contactId);
      setMessage(result.message);
    });
  }

  const inviteStatus = state === "existing_confirmed"
    ? (reasonCode?.startsWith("resend_invite_") ? "pending" : "available")
    : state === "none"
      ? "available"
      : "blocked";

  return (
    <section
      className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/50 p-4"
      data-account-block="true"
      data-account-state={state}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Conta</p>
          <p className="mt-1 text-base font-semibold text-slate-100">
            <span className="mr-2 text-emerald-300" aria-hidden="true">{view.marker}</span>
            {state === "linked_to_other_account" ? linkedOtherAccountLabel(linkedAccountOwnerName) : view.label}
          </p>
          {email ? <p className="mt-1 text-sm text-slate-400">E-mail: {email}</p> : null}
        </div>
      </div>

      {state === "pending_confirmation" ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-300">{PENDING_CONFIRMATION_ADMIN_COPY}</p>
          {canResendConfirmation ? (
            <button
              type="button"
              onClick={resendConfirmation}
              disabled={isPending}
              className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-semibold text-emerald-100 hover:border-emerald-400 disabled:opacity-50"
            >
              {isPending ? "Enviando..." : "Reenviar confirmação"}
            </button>
          ) : null}
          {message ? <p className="text-xs text-slate-300" data-account-feedback="true">{message}</p> : null}
        </div>
      ) : null}

      {state === "none" || state === "existing_confirmed" ? (
        <div className="mt-3">
          <p className="mb-3 text-sm text-slate-300">
            {state === "existing_confirmed"
              ? "Já existe uma conta confirmada com este e-mail. O envio usa a conta existente, sem criar outra Auth."
              : "Esta pessoa ainda não possui uma conta vinculada. Ingressos emitidos para ela ficam com proprietário pretendido até o primeiro acesso."}
          </p>
          <InviteAccountButton
            contactId={contactId}
            canInvite={canInvite}
            inviteStatus={inviteStatus}
            reason={reason}
            inviteRecord={inviteRecord}
            createNewAuth={view.inviteCreatesAuth}
          />
        </div>
      ) : null}

      {state === "active" ? (
        <p className="mt-3 text-sm text-slate-400">Conta vinculada a este Cadastro. Nenhuma ação de criação duplicada.</p>
      ) : null}

      {state === "linked_to_other_account" ? (
        <p className="mt-3 text-sm text-slate-300" data-account-feedback="true">
          {adminAttentionCopy(reasonCode)}
        </p>
      ) : null}

      {state === "attention" ? (
        <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-sm text-amber-100">{adminAttentionCopy(reasonCode)}</p>
        </div>
      ) : null}
    </section>
  );
}
