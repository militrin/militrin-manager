'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRight, CalendarDays, CircleUserRound, Coins, History, Images, LayoutDashboard, ShoppingBag, Star, Ticket, type LucideIcon } from 'lucide-react';
import { CartNavLink, MobileCartLink } from '@/components/store/CartHeaderLink';

type NavItem = { href: string; label: string; icon: LucideIcon; isCart: boolean };

const navigation: NavItem[] = [
  { href: '/minha-conta', label: 'Início', icon: LayoutDashboard, isCart: false },
  { href: '/minha-conta/comprar', label: 'Eventos', icon: CalendarDays, isCart: false },
  { href: '/minha-conta/ingressos', label: 'Meus ingressos', icon: Ticket, isCart: false },
  { href: '/minha-conta/compras', label: 'Minhas compras', icon: Coins, isCart: false },
  { href: '/minha-conta/loja', label: 'Loja', icon: ShoppingBag, isCart: false },
  { href: '/minha-conta/carrinho', label: 'Carrinho de Compras', icon: ShoppingBag, isCart: true },
  { href: '/fotos', label: 'Fotos', icon: Images, isCart: false },
  { href: '/minha-conta/nivel', label: 'Minha categoria - Em breve', icon: Star, isCart: false },
  { href: '/minha-conta/historico', label: 'Histórico', icon: History, isCart: false },
  { href: '/minha-conta/dados', label: 'Meu perfil', icon: CircleUserRound, isCart: false },
];

function isActivePath(pathname: string, href: string) {
  if (href === '/minha-conta') return pathname === '/minha-conta';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AccountSidebarNav({ isAdministrativeUser }: { isAdministrativeUser: boolean }) {
  const pathname = usePathname();

  return (
    <nav className="mt-4 grid gap-2 text-sm" aria-label="Navegação principal do usuário">
      {isAdministrativeUser ? (
        <Link
          href="/painel"
          className={`flex items-center justify-between rounded-2xl border px-4 py-3 font-semibold transition ${
            isActivePath(pathname, '/painel')
              ? 'border-(--brand-400)/50 bg-(--brand-500)/15 text-(--brand-100) hover:bg-(--brand-500)/25'
              : 'border-slate-800 bg-slate-900/70 text-slate-200 hover:border-(--brand-400)/40 hover:bg-slate-900'
          }`}
        >
          <span className="flex items-center gap-3">
            <LayoutDashboard size={16} />
            Painel administrativo
          </span>
          <ArrowRight size={14} />
        </Link>
      ) : null}
      {navigation.map((item) => {
        const active = isActivePath(pathname, item.href);
        if (item.isCart) return <CartNavLink key={item.href} active={active} />;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center justify-between rounded-2xl border px-4 py-3 transition ${
              active
                ? 'border-(--brand-400)/50 bg-(--brand-500)/15 font-semibold text-(--brand-100) hover:bg-(--brand-500)/25'
                : 'border-slate-800 bg-slate-900/70 text-slate-200 hover:border-(--brand-400)/40 hover:bg-slate-900'
            }`}
          >
            <span className="flex items-center gap-3">
              <Icon size={16} />
              {item.label}
            </span>
            <ArrowRight size={14} className={active ? 'text-(--brand-200)' : 'text-slate-500'} />
          </Link>
        );
      })}
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

export function AccountMobileNav({ isAdministrativeUser }: { isAdministrativeUser: boolean }) {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-3 bottom-3 z-40 rounded-2xl border border-slate-800/90 bg-slate-950/90 p-2 shadow-2xl shadow-black/30 backdrop-blur lg:hidden" aria-label="Navegação rápida do usuário">
      <ul className={`grid gap-1 text-[11px] ${isAdministrativeUser ? 'grid-cols-6' : 'grid-cols-5'}`}>
        {isAdministrativeUser ? (
          <li>
            <MobileNavLink href="/painel" label="Painel" icon={LayoutDashboard} active={isActivePath(pathname, '/painel')} />
          </li>
        ) : null}
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
