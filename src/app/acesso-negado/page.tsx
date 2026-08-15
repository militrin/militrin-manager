import Link from 'next/link';

export default function AccessDeniedPage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(248,113,113,0.14),transparent_30%),linear-gradient(135deg,#020617,#0b1220)] px-4 py-10 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-2xl rounded-3xl border border-rose-500/30 bg-slate-900/80 p-8 shadow-2xl shadow-black/20">
        <p className="text-xs uppercase tracking-[0.2em] text-rose-300">Acesso restrito</p>
        <h1 className="mt-2 text-3xl font-semibold">Voce nao possui permissao para esta area.</h1>
        <p className="mt-4 text-sm text-slate-300">
          Se voce acredita que isso e um erro, solicite ao administrador da equipe a liberacao das permissoes necessarias.
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          <Link href="/minha-conta" className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950">
            Ir para minha conta
          </Link>
          <Link href="/" className="rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-200">
            Voltar ao início
          </Link>
        </div>
      </div>
    </main>
  );
}
