'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { signInPublicAccountAction } from '@/app/inscricao/actions';

export function HomeLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setMessage(null);

    const result = await signInPublicAccountAction({
      email,
      password,
      next_path: null,
      wizard_path: null,
    });
    setLoading(false);

    if (!result.success) {
      setMessage(result.message || 'Não foi possível entrar.');
      return;
    }

    router.push(result.redirect_to || '/minha-conta');
  }

  return (
    <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
      <h2 className="text-lg font-semibold text-white">Entrar na minha conta</h2>
      <p className="mt-1 text-xs text-slate-400">Acesse seus ingressos, compras e dados do participante.</p>

      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-slate-300">E-mail</span>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-emerald-400"
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
              className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-emerald-400"
              placeholder="Sua senha"
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              className="inline-flex h-11 items-center justify-center rounded-xl border border-slate-700 px-3 text-slate-200"
              aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
            >
              {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </label>

        {message ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-200">{message}</p> : null}

        <button
          type="submit"
          disabled={loading}
          className="h-11 w-full rounded-xl bg-emerald-400 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? 'Entrando...' : 'Entrar'}
        </button>
      </form>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs">
        <Link href="/esqueci-minha-senha" className="text-slate-300 transition hover:text-white">
          Esqueci minha senha
        </Link>
        <Link href="/criar-conta" className="font-semibold text-emerald-300 transition hover:text-emerald-200">
          Criar minha conta
        </Link>
      </div>
    </div>
  );
}
