'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Shirt, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { signInPublicAccountAction } from '@/app/inscricao/actions';
import { resolvePostAuthDestination } from '@/lib/utils/safe-navigation';

type ParticipantAuthCardProps = {
  title?: string;
  subtitle?: string;
  defaultNext?: string;
};

export function ParticipantAuthCard({
  title = 'Entrar',
  subtitle = 'Acesse suas compras, ingressos e dados do usuário.',
  defaultNext = '/minha-conta',
}: ParticipantAuthCardProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nextFromQuery] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    return params.get('next');
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

    const nextPath = nextFromQuery;
    const wizardPath = getWizardPathFromStorage();
    const fallbackDestination = resolvePostAuthDestination({
      nextPath,
      wizardPath,
      fallback: defaultNext,
    });

    const result = await signInPublicAccountAction({
      email,
      password,
      next_path: nextPath,
      wizard_path: wizardPath,
    });
    setLoading(false);

    if (!result.success) {
      setMessage(result.message || 'Nao foi possivel entrar.');
      return;
    }

    router.push(result.redirect_to || fallbackDestination);
  }

  const createAccountHref = nextFromQuery
    ? `/criar-conta?next=${encodeURIComponent(nextFromQuery)}`
    : '/criar-conta';

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <div className="mx-auto grid w-full max-w-6xl gap-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <section className="space-y-5 rounded-[2rem] border border-slate-800/70 bg-slate-950/60 p-6 shadow-2xl shadow-black/20 sm:p-8">
          <div className="inline-flex items-center gap-3 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-4 py-2 text-sm text-emerald-200">
            <Sparkles size={16} />
            Militrin Participant Portal
          </div>

          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-[linear-gradient(135deg,_#10b981,_#34d399_55%,_#e2e8f0)] text-slate-950 shadow-lg shadow-emerald-500/20">
              <Shirt size={30} strokeWidth={2.4} />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-emerald-300">Militrin</p>
              <h1 className="mt-1 text-3xl font-semibold text-white sm:text-4xl">{title}</h1>
            </div>
          </div>

          <p className="max-w-xl text-sm leading-6 text-slate-300 sm:text-base">{subtitle}</p>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Compras</p>
              <p className="mt-2 text-sm text-slate-200">Acompanhe pedidos, pagamentos e reservas.</p>
            </div>
            <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Ingressos</p>
              <p className="mt-2 text-sm text-slate-200">Abra seus QR codes e baixe os comprovantes.</p>
            </div>
            <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Perfil</p>
              <p className="mt-2 text-sm text-slate-200">Edite seus dados e preferências em um só lugar.</p>
            </div>
          </div>
        </section>

        <section className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-6 shadow-2xl shadow-black/20 sm:p-8">
          <h2 className="text-2xl font-semibold text-white">{title}</h2>
          <p className="mt-2 text-sm text-slate-300">Entre com seu e-mail para acessar o portal.</p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <label className="block space-y-2 text-sm">
              <span className="text-slate-300">E-mail</span>
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-emerald-400"
                placeholder="voce@exemplo.com"
              />
            </label>

            <label className="block space-y-2 text-sm">
              <span className="text-slate-300">Senha</span>
              <div className="flex gap-2">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-emerald-400"
                  placeholder="Sua senha"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="inline-flex h-12 items-center justify-center rounded-2xl border border-slate-700 px-3 text-sm text-slate-200"
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
              className="h-12 w-full rounded-2xl bg-emerald-400 font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? 'Entrando...' : 'Entrar'}
            </button>
          </form>

          <div className="mt-6 flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <Link href="/esqueci-minha-senha" className="text-slate-300 transition hover:text-white">
              Esqueci minha senha
            </Link>
            <Link href={createAccountHref} className="inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-400 px-4 font-semibold text-slate-950 transition hover:bg-emerald-300">
              Criar minha conta
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
