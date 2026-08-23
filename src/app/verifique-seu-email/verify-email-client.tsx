'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { MailCheck } from 'lucide-react';
import { changeEmailBeforeConfirmationAction, resendConfirmationEmailAction, signOutAndGoToLoginAction } from './actions';
import { maskEmail } from '@/lib/account/email-confirmation';

const RESEND_COOLDOWN_MS = 60_000;

export function VerifyEmailClient({ email }: { email: string }) {
  const [currentEmail, setCurrentEmail] = useState(email);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [resendPending, setResendPending] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [cooldownTick, setCooldownTick] = useState(() => Date.now());

  const [changeOpen, setChangeOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [changeMessage, setChangeMessage] = useState<string | null>(null);
  const [changePending, setChangePending] = useState(false);

  useEffect(() => {
    if (!cooldownUntil) return;
    const timer = window.setInterval(() => setCooldownTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const cooldownSeconds = cooldownUntil ? Math.max(0, Math.ceil((cooldownUntil - cooldownTick) / 1000)) : 0;

  async function handleResend() {
    if (resendPending || cooldownSeconds > 0) return;
    setResendPending(true);
    setResendMessage(null);
    const result = await resendConfirmationEmailAction(currentEmail);
    setResendMessage(result.message);
    if (result.success) {
      setCooldownTick(Date.now());
      setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS);
    }
    setResendPending(false);
  }

  async function handleChangeEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (changePending) return;
    setChangePending(true);
    setChangeMessage(null);
    const result = await changeEmailBeforeConfirmationAction({ currentEmail, password, newEmail });
    setChangeMessage(result.message);
    if (result.success) {
      setCurrentEmail(result.email);
      setPassword('');
      setNewEmail('');
      setChangeOpen(false);
    }
    setChangePending(false);
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow),transparent_35%),linear-gradient(180deg,#020617,#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-lg rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 text-center sm:p-8">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-300">
          <MailCheck size={26} />
        </div>
        <h1 className="mt-4 text-2xl font-semibold text-white">Verifique seu e-mail</h1>
        <p className="mt-2 text-sm text-slate-300">
          Enviamos uma mensagem para <strong className="text-slate-100">{maskEmail(currentEmail)}</strong>. Clique em &quot;Validar cadastro&quot; no e-mail para concluir seu acesso.
        </p>

        {resendMessage ? (
          <p className="mt-4 rounded-2xl border border-slate-700 bg-slate-950/60 p-3 text-sm text-slate-200">{resendMessage}</p>
        ) : null}

        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={handleResend}
            disabled={resendPending || cooldownSeconds > 0}
            className="h-11 rounded-2xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {resendPending ? 'Enviando...' : cooldownSeconds > 0 ? `Aguarde ${cooldownSeconds}s` : 'Reenviar e-mail'}
          </button>
          <button
            type="button"
            onClick={() => { setChangeOpen((prev) => !prev); setChangeMessage(null); }}
            className="h-11 rounded-2xl border border-slate-700 px-5 text-sm text-slate-200 transition hover:border-slate-500"
          >
            Trocar e-mail
          </button>
        </div>

        {changeOpen ? (
          <form onSubmit={handleChangeEmail} className="mt-5 space-y-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-left">
            <p className="text-xs text-slate-400">Digite o novo e-mail e sua senha atual para confirmar a troca.</p>
            <label className="block space-y-1 text-sm">
              <span className="text-slate-300">Novo e-mail</span>
              <input
                type="email"
                required
                value={newEmail}
                onChange={(event) => setNewEmail(event.target.value)}
                className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-emerald-400"
              />
            </label>
            <label className="block space-y-1 text-sm">
              <span className="text-slate-300">Senha atual</span>
              <input
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-emerald-400"
              />
            </label>
            {changeMessage ? <p className="text-sm text-amber-200">{changeMessage}</p> : null}
            <button
              type="submit"
              disabled={changePending}
              className="h-11 w-full rounded-xl bg-emerald-400 text-sm font-semibold text-slate-950 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {changePending ? 'Atualizando...' : 'Confirmar novo e-mail'}
            </button>
          </form>
        ) : null}

        <div className="mt-6 border-t border-slate-800 pt-4">
          <form action={signOutAndGoToLoginAction}>
            <button type="submit" className="text-sm text-slate-300 underline transition hover:text-white">
              Voltar para entrar
            </button>
          </form>
        </div>

        <p className="mt-4 text-xs text-slate-500">Não recebeu? Confira também sua caixa de spam.</p>
        <p className="mt-1 text-xs text-slate-500">
          Precisa de ajuda? <Link href="/esqueci-minha-senha" className="underline">Esqueceu sua senha</Link>?
        </p>
      </section>
    </main>
  );
}
