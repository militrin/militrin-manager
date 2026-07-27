'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { completeFirstAccessAction } from './actions';

export function FirstAccessForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function onSubmit(formData: FormData) {
    setMessage(null);

    startTransition(async () => {
      const result = await completeFirstAccessAction(formData);
      if (!result.success) {
        setMessage(result.message);
        return;
      }

      router.push('/minha-conta');
    });
  }

  return (
    <form action={onSubmit} className="mt-6 space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm text-slate-300">
          <span>Nome completo</span>
          <input name="full_name" required className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
        </label>

        <label className="space-y-1 text-sm text-slate-300">
          <span>Data de nascimento</span>
          <input name="birth_date" required placeholder="dd/mm/aaaa" className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
        </label>

        <label className="space-y-1 text-sm text-slate-300">
          <span>Gênero</span>
          <input name="gender" required className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
        </label>

        <label className="space-y-1 text-sm text-slate-300">
          <span>Telefone</span>
          <input name="phone" required className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
        </label>

        <label className="space-y-1 text-sm text-slate-300 md:col-span-2">
          <span>Cidade</span>
          <input name="city" required className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm text-slate-300">
          <span>Nova senha</span>
          <input name="new_password" type="password" minLength={8} required className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
        </label>

        <label className="space-y-1 text-sm text-slate-300">
          <span>Confirmar senha</span>
          <input name="confirm_password" type="password" minLength={8} required className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
        </label>
      </div>

      {message ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{message}</p> : null}

      <button type="submit" disabled={isPending} className="h-11 rounded-xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 disabled:opacity-60">
        {isPending ? 'Salvando...' : 'Concluir primeiro acesso'}
      </button>
    </form>
  );
}
