'use client';

import Link from 'next/link';
import { useState } from 'react';
import { requestPasswordResetAction } from '@/app/inscricao/actions';

export default function EsqueciMinhaSenhaPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setMessage(null);

    const result = await requestPasswordResetAction(email);
    setLoading(false);

    if (!result.success) {
      setMessage(result.message || 'Falha ao solicitar redefinicao.');
      return;
    }

    setMessage('Se existir uma conta para este e-mail, voce recebera as instrucoes de redefinicao.');
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <div className="mx-auto w-full max-w-md rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
        <h1 className="text-2xl font-semibold">Esqueci minha senha</h1>
        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <input type="email" required placeholder="Seu e-mail" value={email} onChange={(e) => setEmail(e.target.value)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
          {message ? <p className="text-sm text-slate-200">{message}</p> : null}
          <button type="submit" disabled={loading} className="h-11 w-full rounded-xl bg-emerald-500 font-semibold text-emerald-950 disabled:opacity-60">
            {loading ? 'Enviando...' : 'Enviar link de redefinicao'}
          </button>
        </form>
        <Link href="/entrar" className="mt-4 inline-block text-sm text-slate-300 hover:underline">Voltar para entrar</Link>
      </div>
    </main>
  );
}
