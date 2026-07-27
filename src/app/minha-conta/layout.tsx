import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { signOutAccountAction } from '@/app/minha-conta/actions';
import { ArrowRight, CircleUserRound, Coins, Images, LogOut, Megaphone, ShoppingBag, Star, Ticket, UsersRound } from 'lucide-react';

const navigation = [
  { href: '/minha-conta', label: 'Início', icon: CircleUserRound },
  { href: '/minha-conta/compras', label: 'Suas compras', icon: Coins },
  { href: '/minha-conta/comprar', label: 'Comprar ingressos', icon: ShoppingBag },
  { href: '/minha-conta/ingressos', label: 'Meus ingressos', icon: Ticket },
  { href: '/minha-conta/nivel', label: 'Meu nível', icon: Star },
  { href: '/minha-conta/dados', label: 'Meus dados', icon: CircleUserRound },
  { href: '/minha-conta/fotos', label: 'Fotos — Em breve', icon: Images },
  { href: '/minha-conta/amigos', label: 'Amigos — Em breve', icon: UsersRound },
  { href: '/minha-conta/ranking', label: 'Ranking — Em breve', icon: Megaphone },
];

export default async function MinhaContaLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/?next=/minha-conta');
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 lg:flex-row">
        <aside className="rounded-[2rem] border border-slate-800/80 bg-slate-950/65 p-5 shadow-2xl shadow-black/20 lg:w-80">
          <div className="flex items-center gap-3 border-b border-slate-800/80 pb-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[linear-gradient(135deg,_#10b981,_#34d399_55%,_#e2e8f0)] text-slate-950">
              <Ticket size={22} />
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-emerald-300">Militrin</p>
              <h1 className="text-xl font-semibold">Minha conta</h1>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-slate-800/80 bg-slate-900/70 p-4 text-sm text-slate-300">
            <p className="text-xs uppercase tracking-[0.22em] text-slate-500">Logado como</p>
            <p className="mt-2 break-words text-slate-100">{user.email}</p>
          </div>

          <nav className="mt-4 grid gap-2 text-sm">
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center justify-between rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3 text-slate-200 transition hover:border-emerald-400/40 hover:bg-slate-900"
                >
                  <span className="flex items-center gap-3">
                    <Icon size={16} />
                    {item.label}
                  </span>
                  <ArrowRight size={14} className="text-slate-500" />
                </Link>
              );
            })}
          </nav>

          <form action={signOutAccountAction} className="mt-5">
            <button type="submit" className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 text-sm font-medium text-rose-200 transition hover:bg-rose-500/20">
              <LogOut size={16} />
              Sair
            </button>
          </form>
        </aside>

        <div className="flex-1">{children}</div>
      </div>
    </main>
  );
}
