"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ChevronRight,
  CircleUserRound,
  FileText,
  LayoutDashboard,
  LogOut,
  Menu,
  ScanLine,
  Shirt,
  Users,
  X,
} from "lucide-react";
import { getSidebarContextAction, signOutAdministrativePanelAction, type SidebarContext } from "./sidebar-actions";
import {
  adminNavGroups as groups,
  findAdminNavItem,
  isAdminNavItemVisible as isItemVisible,
  EVENT_SCOPED_HREFS,
  type AdminNavGroup,
} from "@/lib/navigation/admin-menu";

// Navegacao administrativa: a MESMA fonte de dados (adminNavGroups/
// isAdminNavItemVisible em src/lib/navigation/admin-menu.ts) alimenta a
// sidebar desktop (inalterada, "hidden lg:flex") e as 3 pecas moveis novas
// (header com titulo+hamburguer, drawer completo, bottom nav enxuta) --
// nunca duas listas de rotas/permissoes divergentes.

// ── bottom nav administrativa (5 slots fixos) ───────────────────────────────

type BottomNavSlot = {
  key: string;
  label: string;
  href: string;
  icon: React.ElementType;
  emphasize?: boolean;
};

const BOTTOM_NAV_SLOTS: BottomNavSlot[] = [
  { key: "painel", label: "Painel", href: "/painel", icon: LayoutDashboard },
  { key: "pessoas", label: "Pessoas", href: "/cadastros", icon: Users },
  { key: "scanner", label: "Scanner", href: "/operacoes/turbo", icon: ScanLine, emphasize: true },
  { key: "pedidos", label: "Pedidos", href: "/pedidos", icon: FileText },
];

function isActivePath(pathname: string, href: string, hasExactMatch: boolean) {
  if (hasExactMatch) return pathname === href;
  return pathname === href || (href !== "/painel" && pathname.startsWith(`${href}/`));
}

function eventScopedHref(href: string, selectedEventId: string | null) {
  return selectedEventId && EVENT_SCOPED_HREFS.includes(href)
    ? `${href}?eventId=${encodeURIComponent(selectedEventId)}`
    : href;
}

// ── componente ────────────────────────────────────────────────────────────

function SidebarContent() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [context, setContext] = useState<SidebarContext | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const selectedEventId = searchParams.get("eventId");

  useEffect(() => {
    let mounted = true;
    getSidebarContextAction()
      .then((ctx) => { if (mounted) setContext(ctx); })
      .catch(() => { if (mounted) setContext({ permissionMap: {}, capabilities: { eventId: null, organizationId: null, hasEvents: false, registrationEnabled: false, hasOrders: false, hasFinance: false, hasCheckin: false, hasDistributableItems: false, hasInventory: false, hasDeliverySchedule: false, hasWristbands: false, hasPhotos: false } }); });
    return () => { mounted = false; };
  }, []);

  const visibleGroups = useMemo(() => {
    if (!context) return [];

    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          isItemVisible(item, context.permissionMap, context.capabilities),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [context]);

  // "/operacoes" e "/operacoes/turbo" (e "/operacoes/pulseira") sao
  // subareas irmas, nao pai/filho de navegacao -- sem isso, o prefix-match
  // abaixo marcaria "Central de Operações" ativo junto com "Modo Turbo"
  // sempre que pathname.startsWith("/operacoes/"). Quando algum item bate
  // EXATAMENTE com o pathname atual, so ele fica ativo; o prefix-match so
  // serve de fallback pra rotas sem item proprio no menu (ex.: /cadastros/[id]).
  const hasExactMatch = useMemo(
    () => visibleGroups.some((group) => group.items.some((item) => item.href === pathname)),
    [visibleGroups, pathname],
  );

  // Titulo do header mobile -- deriva do MESMO menu (nenhuma pagina precisa
  // passar um titulo manualmente): acha o item cujo href bate com a rota
  // atual (match exato, ou prefixo mais especifico como fallback).
  const currentPageLabel = useMemo(() => {
    const allItems = visibleGroups.flatMap((g) => g.items);
    const exact = allItems.find((item) => item.href === pathname);
    if (exact) return exact.label;
    const byPrefix = allItems
      .filter((item) => pathname.startsWith(`${item.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0];
    return byPrefix?.label ?? "Central administrativa";
  }, [visibleGroups, pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [drawerOpen]);

  function navLink(item: { label: string; icon: React.ElementType; href: string }, active: boolean, onNavigate?: () => void, compact = false) {
    const Icon = item.icon;
    const href = eventScopedHref(item.href, selectedEventId);
    return (
      <Link
        key={item.href}
        href={href}
        onClick={(event) => {
          onNavigate?.();
          if (item.href === "/cadastros") {
            event.preventDefault();
            router.push(href);
          }
        }}
        className={`flex w-full items-center justify-between rounded-2xl px-4 text-left font-medium transition ${compact ? "py-2.5 text-sm" : "py-3.5 text-base"} ${
          active
            ? "bg-emerald-500/15 text-emerald-300"
            : "text-slate-300 hover:bg-slate-800/80 hover:text-white active:bg-slate-800"
        }`}
      >
        <span className="flex items-center gap-3">
          <Icon size={compact ? 18 : 20} />
          {item.label}
        </span>
        <ChevronRight size={16} />
      </Link>
    );
  }

  function renderGroups(compact: boolean, onNavigate?: () => void) {
    return (
      <>
        {visibleGroups.map((group: AdminNavGroup) => (
          <div key={group.label}>
            <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              {group.label}
            </p>
            <div className="space-y-1">
              {group.items.map((item) => navLink(item, isActivePath(pathname, item.href, hasExactMatch), onNavigate, compact))}
            </div>
          </div>
        ))}

        {!context && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-11 animate-pulse rounded-2xl bg-slate-800/60" />
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {/* ============================================================
          DESKTOP -- sidebar fixa lateral. Inalterada (mesmas classes de
          sempre, "hidden lg:flex"): a experiencia desktop nao muda em
          nada com a adicao das pecas moveis abaixo.
          ============================================================ */}
      <aside className="hidden w-72 flex-col justify-between rounded-3xl border border-slate-800/80 bg-slate-900/80 p-6 shadow-2xl shadow-black/20 lg:flex">
        <div>
          <div className="mb-8 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500/20 text-emerald-400">
              <Shirt size={20} />
            </div>
            <div>
              <p className="text-lg font-semibold text-slate-100">Militrin Manager</p>
              <p className="text-sm text-slate-400">Painel administrativo</p>
            </div>
          </div>

          {/* Troca de area -- NAO e logout ("Sair da conta" continua so no
              rodape, exclusivo pra encerrar sessao). Perto do topo, antes
              dos grupos de navegacao, pra nunca ficar perdido numa lista
              longa. */}
          <Link
            href="/minha-conta"
            className="mb-6 flex items-center justify-between rounded-2xl border border-slate-700/80 bg-slate-800/40 px-4 py-3 text-sm font-medium text-slate-200 transition hover:border-emerald-400/40 hover:bg-slate-800/70 hover:text-white"
          >
            <span className="flex items-center gap-3">
              <CircleUserRound size={18} />
              Ir para Minha Conta
            </span>
            <ChevronRight size={15} />
          </Link>

          <nav className="space-y-6">{renderGroups(false)}</nav>
        </div>

        <div className="space-y-3">
          {context && !context.capabilities.hasEvents && (
            <div className="rounded-2xl border border-slate-700/40 bg-slate-800/40 p-4 text-sm text-slate-400">
              <p className="font-medium text-slate-300">Nenhum evento disponível</p>
              <p className="mt-1 text-xs">Cadastre ou restaure um evento para usar os módulos específicos.</p>
            </div>
          )}

          {context && context.capabilities.hasEvents && (
            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
              <div className="mb-2 flex items-center gap-2">
                <AlertTriangle size={16} />
                <span className="font-semibold">Navegação protegida</span>
              </div>
              <p>Os itens do menu são exibidos conforme suas permissões e os recursos dos eventos da organização.</p>
            </div>
          )}

          <form action={signOutAdministrativePanelAction}>
            <button type="submit" className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 text-sm font-medium text-rose-200 transition hover:bg-rose-500/20">
              <LogOut size={17} />
              Sair da conta
            </button>
          </form>
        </div>
      </aside>

      {/* ============================================================
          MOBILE -- header fixo (titulo + hamburguer). "lg:hidden" ==
          some exatamente onde a sidebar desktop aparece.
          ============================================================ */}
      <header
        className="fixed inset-x-0 top-0 z-40 flex items-center gap-3 border-b border-slate-800/80 bg-slate-950/95 px-4 backdrop-blur lg:hidden"
        style={{ paddingTop: "var(--safe-top)", height: "calc(var(--mobile-header-h) + var(--safe-top))" }}
      >
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Abrir menu administrativo"
          aria-expanded={drawerOpen}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-200 active:bg-slate-800"
        >
          <Menu size={20} />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-slate-100">{currentPageLabel}</h1>
        {/* Troca de area em 1 toque, sempre visivel (nunca atras do drawer/
            bottom nav) -- NAO e logout, so leva pra /minha-conta. */}
        <Link
          href="/minha-conta"
          aria-label="Ir para Minha Conta"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-200 active:bg-slate-800"
        >
          <CircleUserRound size={20} />
        </Link>
      </header>

      {/* ============================================================
          MOBILE -- drawer completo (todas as areas administrativas
          disponiveis, respeitando as MESMAS permissoes do desktop).
          Tambem e o alvo do botao "Mais" da bottom nav.
          ============================================================ */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu administrativo">
          <button
            type="button"
            aria-label="Fechar menu"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
          />
          <div
            className="absolute inset-y-0 left-0 flex w-[85%] max-w-sm flex-col overflow-y-auto border-r border-slate-800 bg-slate-950 shadow-2xl"
            style={{ paddingTop: "var(--safe-top)", paddingBottom: "var(--safe-bottom)" }}
          >
            <div className="flex items-center justify-between gap-3 border-b border-slate-800/80 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500/20 text-emerald-400">
                  <Shirt size={20} />
                </div>
                <div>
                  <p className="text-base font-semibold text-slate-100">Militrin Manager</p>
                  <p className="text-xs text-slate-400">Painel administrativo</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Fechar menu"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-700 text-slate-300 active:bg-slate-800"
              >
                <X size={18} />
              </button>
            </div>

            <nav className="flex-1 space-y-6 px-4 py-5">
              {/* Perto do topo, ANTES dos grupos filtrados por permissao --
                  nunca escondido no fim de uma lista longa. */}
              <Link
                href="/minha-conta"
                onClick={() => setDrawerOpen(false)}
                className="flex items-center justify-between rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 text-left text-base font-medium text-emerald-200 transition hover:bg-emerald-500/20 py-3.5"
              >
                <span className="flex items-center gap-3">
                  <CircleUserRound size={20} />
                  Ir para Minha Conta
                </span>
                <ChevronRight size={16} />
              </Link>
              {renderGroups(false, () => setDrawerOpen(false))}
            </nav>

            <div className="border-t border-slate-800/80 p-4">
              <form action={signOutAdministrativePanelAction}>
                <button type="submit" className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 text-sm font-medium text-rose-200 active:bg-rose-500/20">
                  <LogOut size={17} />
                  Sair da conta
                </button>
              </form>
            </div>
          </div>
        </div>
      ) : null}

      {/* ============================================================
          MOBILE -- bottom nav enxuta (Painel/Pessoas/Scanner/Pedidos/
          Mais). "data-admin-mobile-bottom-nav" e o gancho que faz o
          <main> de toda pagina administrativa reservar espaco pra ela
          (ver globals.css, regra :has()) sem precisar editar cada
          pagina uma por uma.
          ============================================================ */}
      <nav
        data-admin-mobile-bottom-nav
        aria-label="Navegação rápida administrativa"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-800/90 bg-slate-950/95 backdrop-blur lg:hidden"
        style={{ paddingBottom: "var(--safe-bottom)" }}
      >
        <ul className="grid h-(--mobile-bottomnav-h) grid-cols-5 items-center gap-1 px-1 text-[10px]">
          {BOTTOM_NAV_SLOTS.map((slot) => {
            const navItem = findAdminNavItem(slot.href);
            const visible = context && navItem ? isItemVisible(navItem, context.permissionMap, context.capabilities) : false;
            const active = isActivePath(pathname, slot.href, hasExactMatch);
            const Icon = slot.icon;

            if (slot.emphasize) {
              return (
                <li key={slot.key} className="flex justify-center">
                  {visible ? (
                    <Link
                      href={eventScopedHref(slot.href, selectedEventId)}
                      aria-label={slot.label}
                      className={`-mt-6 flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-full border-4 border-slate-950 shadow-lg transition ${
                        active ? "bg-emerald-400 text-emerald-950" : "bg-emerald-500 text-emerald-950 active:bg-emerald-400"
                      }`}
                    >
                      <Icon size={22} />
                    </Link>
                  ) : (
                    <span className="-mt-6 flex h-14 w-14 items-center justify-center rounded-full border-4 border-slate-950 bg-slate-800 text-slate-600" aria-hidden>
                      <Icon size={22} />
                    </span>
                  )}
                  <span className="sr-only">{slot.label}</span>
                </li>
              );
            }

            return (
              <li key={slot.key}>
                {visible ? (
                  <Link
                    href={eventScopedHref(slot.href, selectedEventId)}
                    className={`flex flex-col items-center gap-1 rounded-xl px-1 py-2 ${active ? "font-semibold text-emerald-300" : "text-slate-300"}`}
                  >
                    <Icon size={18} />
                    {slot.label}
                  </Link>
                ) : (
                  <span className="flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-slate-700" aria-hidden>
                    <Icon size={18} />
                    {slot.label}
                  </span>
                )}
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Abrir menu completo"
              className="flex w-full flex-col items-center gap-1 rounded-xl px-1 py-2 text-slate-300 active:bg-slate-800"
            >
              <Menu size={18} />
              Mais
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}

export function Sidebar() {
  return (
    <Suspense fallback={<aside className="hidden w-72 shrink-0 lg:block" aria-label="Carregando navegação" />}>
      <SidebarContent />
    </Suspense>
  );
}
