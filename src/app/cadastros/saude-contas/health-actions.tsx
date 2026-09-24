"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AccountHealthAction, AccountHealthIdentityConflict, AccountHealthState } from "@/lib/account/account-health";
import { PENDING_CONFIRMATION_ADMIN_COPY } from "@/lib/account/first-access-invite-copy";
import { formatDateTimeBR } from "@/lib/utils/date";
import {
  correctAccountHealthEmailAction,
  keepAccountHealthWithoutAccountAction,
  reanalyzeAccountHealthCaseAction,
  reopenAccountHealthResolutionAction,
  resendAccountHealthConfirmationAction,
  sendAccountHealthAccessAction,
  sendAccountHealthInviteAction,
} from "./actions";

const buttonClass = "inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold disabled:opacity-50";

function Dialog({
  title,
  open,
  close,
  children,
}: {
  title: string;
  open: boolean;
  close: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button type="button" onClick={close} aria-label="Fechar" className="text-slate-400 hover:text-white">×</button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

function confirmedLabel(value: boolean | null | undefined) {
  if (value === true) return "Confirmada";
  if (value === false) return "Não confirmada";
  return "Não disponível";
}

export function AccountHealthCaseActions({
  caseId,
  state,
  actions,
  canAct,
  canResolve,
  identityConflict,
}: {
  caseId: string;
  state: AccountHealthState;
  actions: AccountHealthAction[];
  canAct: boolean;
  canResolve: boolean;
  identityConflict?: AccountHealthIdentityConflict | null;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"keep" | "email" | "identity" | null>(null);
  const [email, setEmail] = useState("");
  const [emailConfirm, setEmailConfirm] = useState("");
  const [isPending, startTransition] = useTransition();

  function run(task: () => Promise<{ success: boolean; message: string }>, closeDialog = false) {
    setMessage(null);
    startTransition(async () => {
      const result = await task();
      setMessage(result.message);
      if (result.success) {
        if (closeDialog) setDialog(null);
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-3">
      {state === "pending_confirmation" ? (
        <p className="text-sm text-slate-300">{PENDING_CONFIRMATION_ADMIN_COPY}</p>
      ) : null}
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
        {canResolve && actions.includes("keep_without_account") ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => { setMessage(null); setDialog("keep"); }}
            className={`${buttonClass} border border-slate-500 bg-slate-800 text-slate-100`}
          >
            Manter sem conta
          </button>
        ) : null}
        {canResolve && actions.includes("provide_own_email") ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => { setMessage(null); setEmail(""); setEmailConfirm(""); setDialog("email"); }}
            className={`${buttonClass} border border-sky-500/40 bg-sky-500/10 text-sky-100`}
          >
            Informar e-mail próprio
          </button>
        ) : null}
        {actions.includes("review_identity") ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => { setMessage(null); setDialog("identity"); }}
            className={`${buttonClass} border border-amber-500/40 bg-amber-500/10 text-amber-100`}
          >
            Revisar identidade
          </button>
        ) : null}
        {canResolve && actions.includes("reopen_review") ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(() => reopenAccountHealthResolutionAction(caseId))}
            className={`${buttonClass} border border-slate-500 text-slate-100`}
          >
            Reabrir análise
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
      {state === "possible_orphan" ? (
        <p className="text-sm text-slate-300">Possível conta sem vínculo operacional. Nesta versão não há exclusão, mesclagem nem consolidação automática.</p>
      ) : null}
      {message ? <p className="text-sm text-slate-300" data-account-health-feedback="true">{message}</p> : null}

      <Dialog title="Manter sem conta?" open={dialog === "keep"} close={() => setDialog(null)}>
        <div className="space-y-4 text-sm text-slate-200">
          <p>Esta decisão é só sobre acesso à conta. O Cadastro, a participação, o titular quando aplicável e os ingressos continuam válidos. Não criar nem vincular conta própria usando este e-mail compartilhado.</p>
          <p className="text-slate-400">O que muda: apenas o registro da decisão. O que não muda: Cadastro, conta, participação, pedidos e ingressos.</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setDialog(null)} className={`${buttonClass} border border-slate-700`}>Cancelar</button>
            <button
              type="button"
              disabled={isPending}
              onClick={() => run(() => keepAccountHealthWithoutAccountAction(caseId), true)}
              className={`${buttonClass} bg-emerald-500 text-emerald-950`}
            >
              {isPending ? "Salvando..." : "Manter sem conta"}
            </button>
          </div>
        </div>
      </Dialog>

      <Dialog title="Informar e-mail próprio" open={dialog === "email"} close={() => setDialog(null)}>
        <form
          className="space-y-4 text-sm"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => correctAccountHealthEmailAction(caseId, email, emailConfirm), true);
          }}
        >
          <p className="text-slate-300">Use um e-mail que pertença a esta pessoa. Nenhuma conta será criada agora e nenhum convite será enviado. Depois você poderá enviar o convite se quiser.</p>
          <label className="grid gap-1">
            <span className="text-xs text-slate-400">Novo e-mail</span>
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="h-11 rounded-xl border border-slate-700 bg-slate-950 px-3" required />
          </label>
          <label className="grid gap-1">
            <span className="text-xs text-slate-400">Confirmar novo e-mail</span>
            <input type="email" value={emailConfirm} onChange={(event) => setEmailConfirm(event.target.value)} className="h-11 rounded-xl border border-slate-700 bg-slate-950 px-3" required />
          </label>
          {message && dialog === "email" ? <p className="text-sm text-amber-200">{message}</p> : null}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setDialog(null)} className={`${buttonClass} border border-slate-700`}>Cancelar</button>
            <button type="submit" disabled={isPending} className={`${buttonClass} bg-sky-500 text-sky-950`}>
              {isPending ? "Salvando..." : "Salvar e-mail"}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog title="Conflito de conta" open={dialog === "identity"} close={() => setDialog(null)}>
        <div className="space-y-4 text-sm text-slate-200">
          <p>{identityConflict?.message || "Este Cadastro já está vinculado a uma conta ativa, mas o e-mail cadastrado está sendo usado por outra conta. A correção exige revisar qual conta deve permanecer."}</p>
          <dl className="grid gap-2 rounded-2xl border border-slate-800 bg-slate-950/70 p-3">
            <div><dt className="text-xs text-slate-500">E-mail do Cadastro</dt><dd>{identityConflict?.cadastro_email || "—"}</dd></div>
            <div><dt className="text-xs text-slate-500">E-mail da conta vinculada</dt><dd>{identityConflict?.linked_email || "—"}</dd></div>
            <div><dt className="text-xs text-slate-500">Estado da conta vinculada</dt><dd>{confirmedLabel(identityConflict?.linked_confirmed)} · último acesso {identityConflict?.linked_last_sign_in_at ? formatDateTimeBR(identityConflict.linked_last_sign_in_at) : "não disponível"}</dd></div>
            <div><dt className="text-xs text-slate-500">Conta que usa o e-mail cadastrado</dt><dd>{identityConflict?.occupying_email || "—"}</dd></div>
            <div><dt className="text-xs text-slate-500">Estado dessa outra conta</dt><dd>{confirmedLabel(identityConflict?.occupying_confirmed)} · último acesso {identityConflict?.occupying_last_sign_in_at ? formatDateTimeBR(identityConflict.occupying_last_sign_in_at) : "não disponível"}</dd></div>
            <div><dt className="text-xs text-slate-500">Essa outra conta tem Cadastro?</dt><dd>{identityConflict?.occupying_has_cadastro ? "Sim" : "Não"}</dd></div>
          </dl>
          <p className="text-slate-400">Participação, pedidos e ingressos desta pessoa continuam visíveis nesta ficha. Nada aqui transfere ingresso, troca dono da conta ou une Cadastros.</p>
          <p className="rounded-xl border border-amber-700/40 bg-amber-950/30 p-3 text-amber-100">Este caso requer tratamento excepcional. Nesta versão a análise é só leitura: não há correção automática segura.</p>
          <div className="flex justify-end">
            <button type="button" onClick={() => setDialog(null)} className={`${buttonClass} border border-slate-700`}>Fechar</button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
