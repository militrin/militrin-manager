import Link from 'next/link';
import { Home } from 'lucide-react';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export async function HomeButton() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const href = user ? '/minha-conta' : '/';

  return (
    <Link
      href={href}
      aria-label="Página inicial"
      title="Página inicial"
      className="fixed left-3 top-3 z-50 flex h-10 w-10 items-center justify-center rounded-full border border-slate-700/80 bg-slate-950/80 text-slate-200 shadow-lg shadow-black/30 backdrop-blur transition hover:border-emerald-400/60 hover:text-emerald-200"
    >
      <Home size={18} />
    </Link>
  );
}
