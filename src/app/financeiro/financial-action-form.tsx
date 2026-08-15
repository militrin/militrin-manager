"use client";

import { useActionState, useId } from "react";
import type { FormEvent, ReactNode } from "react";
import type { FinancialActionState } from "./actions";

const initial: FinancialActionState = { success: false, message: "" };

export function FinancialActionForm({ action, children, submitLabel, idempotencyScope, tone = "default" }: {
  action: (state: FinancialActionState, form: FormData) => Promise<FinancialActionState>;
  children: ReactNode;
  submitLabel: string;
  idempotencyScope?: string;
  tone?: "default" | "danger";
}) {
  const [state, formAction, pending] = useActionState(action, initial);
  const formId = useId();
  const prepareSubmission = (event: FormEvent<HTMLFormElement>) => {
    if (!idempotencyScope) return;
    const input = event.currentTarget.elements.namedItem("idempotencyKey");
    if (input instanceof HTMLInputElement) input.value = `${idempotencyScope}:${crypto.randomUUID()}`;
  };
  return <form action={formAction} onSubmit={prepareSubmission} className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
    {idempotencyScope ? <input type="hidden" name="idempotencyKey" defaultValue={`${idempotencyScope}:${formId}:initial`}/> : null}
    {children}
    {state.message ? <div aria-live="polite" className={state.success ? "text-sm text-emerald-300" : "text-sm text-rose-300"}><p>{state.message}</p>{state.success && state.id ? <p className="mt-1 break-all font-mono text-xs">ID: {state.id}</p> : null}</div> : null}
    <button disabled={pending} className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 ${tone === "danger" ? "bg-rose-500 text-white" : "bg-emerald-500 text-slate-950"}`}>{pending ? "Processando…" : submitLabel}</button>
  </form>;
}
