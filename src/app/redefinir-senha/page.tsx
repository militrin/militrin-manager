'use client';

import Link from 'next/link';
import { useState } from 'react';
import { updatePublicPasswordAction } from '@/app/inscricao/actions';

export default function RedefinirSenhaPage() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    const result = await updatePublicPasswordAction({ password, confirmPassword });
    setLoading(false);

    if (!result.success) {
      setMessage(result.message || 'Nao foi possivel redefinir a senha.');
      return;
    }

    setDone(true);
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <div className="mx-auto w-full max-w-md rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
        {done ? (
          <>
            <h1 className="text-2xl font-semibold">Senha alterada com sucesso</h1>
            <p className="mt-2 text-sm text-slate-300">Sua senha foi atualizada. Você já pode entrar com a nova senha.</p>
            <Link href="/entrar" className="mt-5 inline-flex h-11 items-center justify-center rounded-xl bg-emerald-500 px-5 font-semibold text-emerald-950">
              Entrar na minha conta
            </Link>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold">Redefinir senha</h1>
            <form onSubmit={onSubmit} className="mt-4 space-y-3">
              <input type="password" required minLength={8} placeholder="Nova senha" value={password} onChange={(e) => setPassword(e.target.value)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
              <input type="password" required minLength={8} placeholder="Confirmar nova senha" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
              {message ? <p className="text-sm text-rose-300">{message}</p> : null}
              <button type="submit" disabled={loading} className="h-11 w-full rounded-xl bg-emerald-500 font-semibold text-emerald-950 disabled:opacity-60">
                {loading ? 'Salvando...' : 'Salvar nova senha'}
              </button>
            </form>
            <Link href="/entrar" className="mt-4 inline-block text-sm text-slate-300 hover:underline">Voltar para entrar</Link>
          </>
        )}
      </div>
    </main>
  );
}
