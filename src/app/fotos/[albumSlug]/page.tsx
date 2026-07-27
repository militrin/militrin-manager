import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export default async function FotoAlbumPage({ params }: { params: Promise<{ albumSlug: string }> }) {
  const { albumSlug } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-5xl rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Album publico</p>
        <div className="mt-2 flex items-start justify-between gap-3">
          <h1 className="text-3xl font-semibold text-white">{albumSlug.replace(/-/g, ' ')}</h1>
          {user ? (
            <Link href="/minha-conta" className="inline-flex h-10 items-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-500/20">
              Minha conta
            </Link>
          ) : null}
        </div>
        <p className="mt-3 text-sm text-slate-300">
          Este album esta em fase inicial da arquitetura publica. Apenas imagens aprovadas/publicadas serao exibidas aqui quando a estrutura definitiva de galeria for habilitada.
        </p>

        <div className="mt-5 rounded-2xl border border-dashed border-slate-700 bg-slate-950/60 p-6 text-sm text-slate-400">
          Conteudo do album em breve.
        </div>

        <Link href="/fotos" className="mt-5 inline-flex h-11 items-center rounded-2xl border border-slate-700 px-5 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:text-white">
          Voltar para albuns
        </Link>
      </section>
    </main>
  );
}
