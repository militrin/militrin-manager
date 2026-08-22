'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRight, CalendarDays, CircleUserRound, Coins, History, Images, LayoutDashboard, ShieldCheck, ShoppingBag, Star, Ticket, type LucideIcon } from 'lucide-react';
import { CartNavLink, MobileCartLink } from '@/components/store/CartHeaderLink';

type NavItem = { href: string; label: string; icon: LucideIcon; isCart: boolean };

// Mesmos destinos/rotas de sempre, so reagrupados visualmente (nenhuma
// navegacao nova, nenhuma removida) para aproximar do mockup aprovado.
const navigationGroups: Array<{ title: string; items: NavItem[] }> = [
  {
    title: 'Minha conta',
    items: [
      { href: '/minha-conta', label: 'Início', icon: LayoutDashboard, isCart: false },
      { href: '/minha-conta/ingressos', label: 'Meus ingressos', icon: Ticket, isCart: false },
      { href: '/minha-conta/compras', label: 'Minhas compras', icon: Coins, isCart: false },
      { href: '/minha-conta/loja', label: 'Loja', icon: ShoppingBag, isCart: false },
      { href: '/minha-conta/carrinho', label: 'Carrinho de Compras', icon: ShoppingBag, isCart: true },
      { href: '/minha-conta/dados', label: 'Meu perfil', icon: CircleUserRound, isCart: false },
    ],
  },
  {
    title: 'Eventos',
    items: [
      { href: '/minha-conta/comprar', label: 'Eventos', icon: CalendarDays, isCart: false },
      { href: '/fotos', label: 'Fotos', icon: Images, isCart: false },
    ],
  },
  {
    title: 'Mais',
    items: [
      { href: '/minha-conta/nivel', label: 'Minha categoria - Em breve', icon: Star, isCart: false },
      { href: '/minha-conta/historico', label: 'Histórico', icon: History, isCart: false },
    ],
  },
];

function isActivePath(pathname: string, href: string) {
  if (href === '/minha-conta') return pathname === '/minha-conta';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  if (item.isCart) return <CartNavLink active={active} />;
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={`flex items-center justify-between rounded-xl px-3.5 py-2.5 text-sm transition ${
        active
          ? 'bg-(--brand-500) font-semibold text-white shadow-md shadow-(--brand-600)/30'
          : 'text-slate-300 hover:bg-slate-900/70 hover:text-slate-100'
      }`}
    >
      <span className="flex items-center gap-3">
        <Icon size={16} />
        {item.label}
      </span>
      {active ? <ArrowRight size={13} className="text-white/80" /> : null}
    </Link>
  );
}

export function AccountSidebarNav({ isAdministrativeUser, isSponsorUser }: { isAdministrativeUser: boolean; isSponsorUser: boolean }) {
  const pathname = usePathname();

  return (
    <nav className="mt-4 space-y-5" aria-label="Navegação principal do usuário">
      {isAdministrativeUser ? (
        <Link
          href="/painel"
          className={`flex items-center justify-between rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
            isActivePath(pathname, '/painel')
              ? 'bg-(--brand-500) text-white shadow-md shadow-(--brand-600)/30'
              : 'border border-(--brand-500)/30 bg-(--brand-500)/10 text-(--brand-100) hover:bg-(--brand-500)/20'
          }`}
        >
          <span className="flex items-center gap-3">
            <LayoutDashboard size={16} />
            Painel administrativo
          </span>
          <ArrowRight size={13} />
        </Link>
      ) : null}
      {isSponsorUser ? (
        <Link
          href="/minha-conta/patrocinador"
          className={`flex items-center justify-between rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
            isActivePath(pathname, '/minha-conta/patrocinador')
              ? 'bg-amber-500 text-amber-950 shadow-md shadow-amber-600/30'
              : 'border border-amber-500/30 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20'
          }`}
        >
          <span className="flex items-center gap-3">
            <ShieldCheck size={16} />
            Área do patrocinador
          </span>
          <ArrowRight size={13} />
        </Link>
      ) : null}
      {navigationGroups.map((group) => (
        <div key={group.title}>
          <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">{group.title}</p>
          <div className="space-y-0.5">
            {group.items.map((item) => (
              <NavLink key={item.href} item={item} active={isActivePath(pathname, item.href)} />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function MobileNavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: LucideIcon; active: boolean }) {
  return (
    <Link href={href} className={`flex flex-col items-center gap-1 rounded-xl px-2 py-2 ${active ? 'bg-(--brand-500)/15 font-semibold text-(--brand-200)' : 'text-slate-200'}`}>
      <Icon size={15} />
      {label}
    </Link>
  );
}

// Maximo 5 itens principais na navegacao inferior (Inicio, Ingressos,
// Compras, Carrinho, Perfil) -- "Painel administrativo" e "Area do
// patrocinador" sao itens SECUNDARIOS e saem da barra fixa; continuam
// acessiveis (nenhuma funcionalidade removida) como atalhos dentro do
// Perfil (ver src/app/minha-conta/dados/page.tsx), a area secundaria
// natural pra esse tipo de link.
export function AccountMobileNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-3 bottom-3 z-40 rounded-2xl border border-slate-800/90 bg-slate-950/90 p-2 shadow-2xl shadow-black/30 backdrop-blur lg:hidden" aria-label="Navegação rápida do usuário">
      <ul className="grid grid-cols-5 gap-1 text-[11px]">
        <li>
          <MobileNavLink href="/minha-conta" label="Início" icon={LayoutDashboard} active={isActivePath(pathname, '/minha-conta')} />
        </li>
        <li>
          <MobileNavLink href="/minha-conta/ingressos" label="Ingressos" icon={Ticket} active={isActivePath(pathname, '/minha-conta/ingressos')} />
        </li>
        <li>
          <MobileNavLink href="/minha-conta/compras" label="Compras" icon={Coins} active={isActivePath(pathname, '/minha-conta/compras')} />
        </li>
        <li>
          <MobileCartLink active={isActivePath(pathname, '/minha-conta/carrinho')} />
        </li>
        <li>
          <MobileNavLink href="/minha-conta/dados" label="Perfil" icon={CircleUserRound} active={isActivePath(pathname, '/minha-conta/dados')} />
        </li>
      </ul>
    </nav>
  );
}
