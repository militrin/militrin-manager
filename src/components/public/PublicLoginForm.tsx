'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { signInPublicAccountAction } from '@/app/inscricao/actions';
import { resolvePostAuthDestination } from '@/lib/utils/safe-navigation';

type PublicLoginFormProps = {
  defaultNext?: string;
};

// Componente unico de login publico, reutilizado pela home (/) e por /entrar
// -- ambas as rotas precisam permanecer a mesma experiencia visual e
// funcional (identidade, campos, resolucao de "next"), nao duas
// implementacoes paralelas que podem divergir com o tempo.
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
    <form onSubmit={onSubmit} className="space-y-3">
      <label className="block space-y-1 text-sm">
        <span className="text-slate-300">E-mail</span>
        <input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-emerald-400"
          placeholder="voce@exemplo.com"
        />
      </label>

      <label className="block space-y-1 text-sm">
        <span className="text-slate-300">Senha</span>
        <div className="flex gap-2">
          <input
            type={showPassword ? 'text' : 'password'}
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-emerald-400"
            placeholder="Sua senha"
          />
          <button
            type="button"
            onClick={() => setShowPassword((prev) => !prev)}
            className="inline-flex h-12 items-center justify-center rounded-2xl border border-slate-700 px-3 text-slate-200"
            aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </label>

      {message ? <p className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{message}</p> : null}

      <button
        type="submit"
        disabled={loading}
        className="h-12 w-full rounded-2xl bg-emerald-400 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? 'Entrando...' : 'Entrar'}
      </button>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs sm:text-sm">
        <Link href="/esqueci-minha-senha" className="text-slate-300 transition hover:text-white">
          Esqueci minha senha
        </Link>
        <Link href={createAccountHref} className="font-semibold text-emerald-300 transition hover:text-emerald-200">
          Criar minha conta
        </Link>
      </div>
    </form>
  );
}
