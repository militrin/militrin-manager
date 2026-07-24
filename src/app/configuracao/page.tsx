import { AlertTriangle } from "lucide-react";

const requiredEnvVars = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (ou NEXT_PUBLIC_SUPABASE_ANON_KEY)"];

export default function ConfigurationPage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl rounded-3xl border border-slate-800/80 bg-slate-900/80 p-8 shadow-2xl shadow-black/20">
        <div className="flex items-center gap-3 text-amber-300">
          <AlertTriangle size={24} />
          <h1 className="text-2xl font-semibold">Configuração pendente do Supabase</h1>
        </div>

        <p className="mt-4 text-slate-300">
          A aplicação está pronta, mas ainda falta preencher as variáveis de ambiente do Supabase para habilitar o cadastro real.
        </p>

        <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
          <p className="font-medium text-slate-100">Variáveis obrigatórias:</p>
          <ul className="mt-3 space-y-2 text-sm text-slate-300">
            {requiredEnvVars.map((name) => (
              <li key={name} className="rounded-xl bg-slate-900/70 px-3 py-2">{name}</li>
            ))}
          </ul>
        </div>

        <p className="mt-6 text-sm text-slate-400">
          Crie um arquivo .env.local com essas variáveis e reinicie o projeto após configurar o Supabase.
        </p>
      </div>
    </main>
  );
}
