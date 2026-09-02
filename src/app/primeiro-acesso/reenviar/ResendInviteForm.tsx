"use client";

import { useState, useTransition } from "react";
import { requestFirstAccessInviteResendAction } from "./actions";

export function ResendInviteForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [pending, start] = useTransition();

  function submit() {
    start(async () => {
      const result = await requestFirstAccessInviteResendAction(email);
      setMessage(result.message);
      setSubmitted(true);
    });
  }

  return (
    <div className="mt-5 space-y-3">
      <label className="grid gap-1 text-sm text-left">
        <span className="font-medium text-slate-200">E-mail do convite</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="voce@exemplo.com"
          disabled={pending || submitted}
          className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 disabled:opacity-60"
        />
      </label>
      <button
        type="button"
        disabled={pending || submitted || !email.trim()}
        onClick={submit}
        className="inline-flex h-10 w-full items-center justify-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 text-sm font-medium text-emerald-200 disabled:opacity-50"
      >
        {pending ? "Enviando..." : submitted ? "Solicitação enviada" : "Solicitar novo convite"}
      </button>
      {message ? <p role="status" className="text-sm text-slate-300">{message}</p> : null}
    </div>
  );
}
