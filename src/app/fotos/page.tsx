import Link from 'next/link';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const demoAlbums = [
  {
    slug: 'militrin-2026-lancamento',
    title: 'Militrin 2026 - Lancamento',
    description: 'Abertura da temporada e anuncios oficiais.',
  },
  {
    slug: 'militrin-2026-pre-evento',
    title: 'Militrin 2026 - Pre-evento',
    description: 'Bastidores, preparacao e clima da galera.',
  },
];

export default async function FotosPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-5xl space-y-4">
        <header className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-3xl font-semibold text-white">Fotos</h1>
            {user ? (
              <Link href="/minha-conta" className="inline-flex h-10 items-center rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 text-xs font-semibold text-emerald-100 transition hover:bg-emerald-500/20">
                Minha conta
              </Link>
            ) : null}
          </div>
          <p className="mt-2 text-sm text-slate-300">Galeria publica com albuns oficiais. Apenas conteudo publicado aparece aqui.</p>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          {demoAlbums.map((album) => (
            <Link key={album.slug} href={`/fotos/${album.slug}`} className="block rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5 transition hover:border-emerald-500/40">
              <p className="text-lg font-semibold text-slate-100">{album.title}</p>
              <p className="mt-2 text-sm text-slate-300">{album.description}</p>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
