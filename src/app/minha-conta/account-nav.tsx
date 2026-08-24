'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowRight,
  CalendarDays,
  CircleUserRound,
  Coins,
  History,
  LayoutDashboard,
  LogOut,
  Menu as MenuIcon,
  Images,
  ShieldCheck,
  ShoppingBag,
  Star,
  Store,
  Ticket,
  X,
  type LucideIcon,
} from 'lucide-react';
import { CartNavLink, MobileCartLink } from '@/components/store/CartHeaderLink';
import { signOutAccountAction } from '@/app/minha-conta/actions';

type NavItem = { href: string; label: string; icon: LucideIcon; isCart: boolean };

// Mesmos destinos/rotas de sempre (nenhuma navegacao nova, nenhuma
// removida) -- fonte UNICA reutilizada pela sidebar desktop (AccountSidebarNav)
// E pelo drawer "Menu" mobile (ver MenuSheet abaixo), pra nunca ter duas
// listas de rotas divergentes entre as duas apresentacoes.
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

// O destino administrativo e resolvido uma unica vez no layout server-side
// a partir da mesma fonte de navegacao usada pela Sidebar.
function AdminAndSponsorShortcuts({
  administrativeLandingPage,
  isSponsorUser,
  pathname,
  onNavigate,
}: {
  administrativeLandingPage: string | null;
  isSponsorUser: boolean;
  pathname: string;
  onNavigate?: () => void;
}) {
  if (!administrativeLandingPage && !isSponsorUser) return null;
  return (
    <div className="space-y-2">
      {administrativeLandingPage ? (
        <Link
          href={administrativeLandingPage}
          onClick={onNavigate}
          className={`flex items-center justify-between rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
            isActivePath(pathname, administrativeLandingPage)
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
          onClick={onNavigate}
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
    </div>
  );
}

export function AccountSidebarNav({ administrativeLandingPage, isSponsorUser }: { administrativeLandingPage: string | null; isSponsorUser: boolean }) {
  const pathname = usePathname();

  return (
    <nav className="mt-4 space-y-5" aria-label="Navegação principal do usuário">
      <AdminAndSponsorShortcuts administrativeLandingPage={administrativeLandingPage} isSponsorUser={isSponsorUser} pathname={pathname} />
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

// ── "Menu" mobile: bottom sheet com TODAS as funcoes secundarias ───────────
// Aberto pelo botao "Menu" da bottom nav (ultimo slot, substitui "Perfil"
// como item principal). Mesmo grupo de rotas (navigationGroups) + mesmos
// atalhos administrativos/patrocinador do desktop -- so a apresentacao muda
// (sheet deslizando de baixo, em vez de sidebar fixa lateral).
function MenuSheet({
  open,
  onClose,
  pathname,
  administrativeLandingPage,
  isSponsorUser,
}: {
  open: boolean;
  onClose: () => void;
  pathname: string;
  administrativeLandingPage: string | null;
  isSponsorUser: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu da conta">
      <button type="button" aria-label="Fechar menu" onClick={onClose} className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm" />
      <div
        className="absolute inset-x-0 bottom-0 flex max-h-[82vh] w-full flex-col overflow-hidden rounded-t-3xl border-t border-slate-800 bg-slate-950 shadow-2xl"
        style={{ paddingBottom: 'var(--safe-bottom)' }}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-4">
          <p className="text-base font-semibold text-slate-100">Menu</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar menu"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-700 text-slate-300 active:bg-slate-800"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-4 py-5">
          <AdminAndSponsorShortcuts
            administrativeLandingPage={administrativeLandingPage}
            isSponsorUser={isSponsorUser}
            pathname={pathname}
            onNavigate={onClose}
          />
          {navigationGroups.map((group) => (
            <div key={group.title}>
              <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">{group.title}</p>
              <div className="space-y-0.5">
                {group.items.map((item) =>
                  item.isCart ? (
                    <div key={item.href} onClick={onClose}>
                      <CartNavLink active={isActivePath(pathname, item.href)} />
                    </div>
                  ) : (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={onClose}
                      className={`flex items-center justify-between rounded-xl px-3.5 py-2.5 text-sm transition ${
                        isActivePath(pathname, item.href)
                          ? 'bg-(--brand-500) font-semibold text-white shadow-md shadow-(--brand-600)/30'
                          : 'text-slate-300 hover:bg-slate-900/70 hover:text-slate-100'
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <item.icon size={16} />
                        {item.label}
                      </span>
                    </Link>
                  ),
                )}
              </div>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-slate-800/80 p-4">
          <form action={signOutAccountAction}>
            <button type="submit" className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 text-sm font-medium text-rose-200 active:bg-rose-500/20">
              <LogOut size={16} />
              Sair
            </button>
          </form>
        </div>
      </div>
    </div>
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

// Exatamente 5 itens principais na navegacao inferior: Início, Eventos, Loja,
// Carrinho e Menu. "Eventos" e "Loja" (areas de descoberta/compra) substituem
// Ingressos/Compras/Perfil como destaque fixo -- essas 3 (mais Fotos,
// Histórico, Painel, Patrocinador etc.) continuam 100% acessiveis, agora
// dentro do "Menu" (ver MenuSheet acima), nunca removidas.
export function AccountMobileNav({ administrativeLandingPage, isSponsorUser }: { administrativeLandingPage: string | null; isSponsorUser: boolean }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <>
      <nav
        className="fixed inset-x-3 z-40 rounded-2xl border border-slate-800/90 bg-slate-950/90 p-2 shadow-2xl shadow-black/30 backdrop-blur lg:hidden"
        style={{ bottom: 'calc(0.75rem + var(--safe-bottom))' }}
        aria-label="Navegação rápida do usuário"
      >
        <ul className="grid grid-cols-5 gap-1 text-[11px]">
          <li>
            <MobileNavLink href="/minha-conta" label="Início" icon={LayoutDashboard} active={isActivePath(pathname, '/minha-conta')} />
          </li>
          <li>
            <MobileNavLink href="/minha-conta/comprar" label="Eventos" icon={CalendarDays} active={isActivePath(pathname, '/minha-conta/comprar')} />
          </li>
          <li>
            <MobileNavLink href="/minha-conta/loja" label="Loja" icon={Store} active={isActivePath(pathname, '/minha-conta/loja')} />
          </li>
          <li>
            <MobileCartLink active={isActivePath(pathname, '/minha-conta/carrinho')} />
          </li>
          <li>
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              aria-label="Abrir menu"
              aria-expanded={menuOpen}
              className={`flex w-full flex-col items-center gap-1 rounded-xl px-2 py-2 ${menuOpen ? 'bg-(--brand-500)/15 font-semibold text-(--brand-200)' : 'text-slate-200'}`}
            >
              <MenuIcon size={15} />
              Menu
            </button>
          </li>
        </ul>
      </nav>

      <MenuSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        pathname={pathname}
        administrativeLandingPage={administrativeLandingPage}
        isSponsorUser={isSponsorUser}
      />
    </>
  );
}
