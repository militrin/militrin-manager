import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getFirstAccessFlags } from '@/lib/account/first-access';
import { signOutAccountAction } from '@/app/minha-conta/actions';
import { ArrowRight, CircleUserRound, Coins, History, Images, LayoutDashboard, LogOut, Star, Ticket, UsersRound, Trophy } from 'lucide-react';

const navigation = [
  { href: '/minha-conta', label: 'Inicio', icon: LayoutDashboard },
  { href: '/minha-conta/ingressos', label: 'Meus ingressos', icon: Ticket },
  { href: '/minha-conta/compras', label: 'Minhas compras', icon: Coins },
  { href: '/fotos', label: 'Fotos', icon: Images },
  { href: '/minha-conta/nivel', label: 'Minha categoria', icon: Star },
  { href: '/minha-conta/historico', label: 'Historico', icon: History },
  { href: '/minha-conta/dados', label: 'Meu perfil', icon: CircleUserRound },
];

const futureNavigation = [
  { href: '/minha-conta/amigos', label: 'Amigos - Em breve', icon: UsersRound },
  { href: '/minha-conta/ranking', label: 'Ranking - Em breve', icon: Trophy },
];

export default async function MinhaContaLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/entrar?next=/minha-conta');
  }

  const flags = await getFirstAccessFlags(user.id);
  if (flags.mustChangePassword || flags.mustCompleteProfile) {
    redirect('/primeiro-acesso');
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 lg:flex-row">
        <aside className="rounded-[2rem] border border-slate-800/80 bg-slate-950/65 p-5 shadow-2xl shadow-black/20 lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:w-80 lg:overflow-y-auto">
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

          <nav className="mt-4 grid gap-2 text-sm" aria-label="Navegacao principal do participante">
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

          <div className="mt-4">
            <p className="px-2 text-xs uppercase tracking-[0.2em] text-slate-500">Futuro</p>
            <div className="mt-2 grid gap-2 text-sm">
              {futureNavigation.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="flex items-center justify-between rounded-2xl border border-slate-800/80 bg-slate-900/50 px-4 py-3 text-slate-300 transition hover:border-slate-600"
                  >
                    <span className="flex items-center gap-3">
                      <Icon size={16} />
                      {item.label}
                    </span>
                    <ArrowRight size={14} className="text-slate-500" />
                  </Link>
                );
              })}
            </div>
          </div>

          <form action={signOutAccountAction} className="mt-5">
            <button type="submit" className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 text-sm font-medium text-rose-200 transition hover:bg-rose-500/20">
              <LogOut size={16} />
              Sair
            </button>
          </form>
        </aside>

        <div className="flex-1 pb-20 lg:pb-0">{children}</div>
      </div>

      <nav className="fixed inset-x-3 bottom-3 z-40 rounded-2xl border border-slate-800/90 bg-slate-950/90 p-2 shadow-2xl shadow-black/30 backdrop-blur lg:hidden" aria-label="Navegacao rapida do participante">
        <ul className="grid grid-cols-5 gap-1 text-[11px]">
          <li>
            <Link href="/minha-conta" className="flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-slate-200">
              <LayoutDashboard size={15} />
              Inicio
            </Link>
          </li>
          <li>
            <Link href="/minha-conta/ingressos" className="flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-slate-200">
              <Ticket size={15} />
              Ingressos
            </Link>
          </li>
          <li>
            <Link href="/minha-conta/compras" className="flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-slate-200">
              <Coins size={15} />
              Compras
            </Link>
          </li>
          <li>
            <Link href="/minha-conta/nivel" className="flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-slate-200">
              <Star size={15} />
              Categoria
            </Link>
          </li>
          <li>
            <Link href="/minha-conta/dados" className="flex flex-col items-center gap-1 rounded-xl px-2 py-2 text-slate-200">
              <CircleUserRound size={15} />
              Perfil
            </Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
