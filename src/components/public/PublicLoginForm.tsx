'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, CircleUserRound, Eye, EyeOff, Lock, Mail, Shield } from 'lucide-react';
import { useState } from 'react';
import { signInPublicAccountAction } from '@/app/inscricao/actions';
import { resolvePostAuthDestination } from '@/lib/utils/safe-navigation';

type PublicLoginFormProps = {
  defaultNext?: string;
};

const fieldClass = 'h-12 w-full rounded-2xl border border-white/10 bg-slate-950/80 py-3 pl-11 pr-4 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-emerald-400';
const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950';

export function PublicLoginForm({ defaultNext = '/minha-conta' }: PublicLoginFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nextFromQuery] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('next');
  });

  function getWizardPathFromStorage() {
    if (typeof window === 'undefined') return null;
    const saved = window.sessionStorage.getItem('militrin:last-wizard-next');
    return saved?.trim() || null;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setMessage(null);

    const wizardPath = getWizardPathFromStorage();
    const fallbackDestination = resolvePostAuthDestination({
      nextPath: nextFromQuery,
      wizardPath,
      fallback: defaultNext,
    });

    const result = await signInPublicAccountAction({
      email,
      password,
      next_path: nextFromQuery,
      wizard_path: wizardPath,
    });
    setLoading(false);

    if (!result.success) {
      if (result.code === 'email_not_confirmed') {
        router.push(`/verifique-seu-email?email=${encodeURIComponent(email)}`);
        return;
      }
      setMessage(result.message || 'Não foi possível entrar.');
      return;
    }

    router.push(result.redirect_to || fallbackDestination);
  }

  const createAccountHref = nextFromQuery
    ? `/criar-conta?next=${encodeURIComponent(nextFromQuery)}`
    : '/criar-conta';

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <label className="block space-y-1.5 text-sm">
        <span className="text-slate-300">E-mail</span>
        <span className="relative block">
          <Mail size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={fieldClass}
            placeholder="seu@email.com"
            autoComplete="email"
          />
        </span>
      </label>

      <label className="block space-y-1.5 text-sm">
        <span className="text-slate-300">Senha</span>
        <span className="relative block">
          <Lock size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type={showPassword ? 'text' : 'password'}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={`${fieldClass} pr-12`}
            placeholder="Sua senha"
            autoComplete="current-password"
          />
          <button
            type="button"
            onClick={() => setShowPassword((prev) => !prev)}
            className={`absolute right-2 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-slate-400 hover:text-white ${focusRing}`}
            aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </span>
      </label>

      {message ? <p className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{message}</p> : null}

      <button
        type="submit"
        disabled={loading}
        className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-emerald-400 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`}
      >
        {loading ? 'Entrando...' : 'Entrar'}
        {loading ? null : <ArrowRight size={16} />}
      </button>

      <div className="flex justify-end">
        <Link href="/esqueci-minha-senha" className={`text-sm text-slate-400 underline-offset-4 hover:text-white hover:underline ${focusRing}`}>
          Esqueci minha senha?
        </Link>
      </div>

      <div className="flex items-center gap-3 pt-1 text-[11px] uppercase tracking-[0.18em] text-slate-500">
        <span className="h-px flex-1 bg-white/10" />
        ou
        <span className="h-px flex-1 bg-white/10" />
      </div>

      <Link
        href={createAccountHref}
        prefetch={false}
        className={`inline-flex h-12 w-full items-center justify-center gap-2 rounded-full border border-emerald-400/70 bg-transparent text-sm font-semibold text-white transition hover:bg-emerald-400/10 ${focusRing}`}
      >
        <CircleUserRound size={16} />
        Criar minha conta
      </Link>

      <p className="flex items-center justify-center gap-2 pt-1 text-xs text-slate-500">
        <Shield size={13} className="text-emerald-300" />
        Seus dados estão seguros com a gente.
      </p>
    </form>
  );
}
