import { PublicLoginForm } from '@/components/public/PublicLoginForm';

export function HomeLoginForm() {
  return (
    <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
      <h2 className="text-lg font-semibold text-white">Entrar na minha conta</h2>
      <p className="mt-1 text-xs text-slate-400">Acesse seus ingressos, compras e dados do participante.</p>

      <div className="mt-4">
        <PublicLoginForm />
      </div>
    </div>
  );
}
