"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  FileText,
  Gift,
  Import,
  LayoutDashboard,
  Layers,
  LogOut,
  Settings,
  Shirt,
  ShoppingBag,
  Ticket,
  UserPlus,
  UserRoundCog,
  Users,
  Wallet,
  Zap,
} from "lucide-react";
import { getSidebarContextAction, signOutAdministrativePanelAction, type SidebarContext } from "./sidebar-actions";
import type { EventCapabilities } from "@/lib/admin/event-capabilities";

// ── tipos ──────────────────────────────────────────────────────────────────

type NavItem = {
  label: string;
  icon: React.ElementType;
  href: string;
  /** Permissões: basta ter ao menos uma */
  permissionAny: string[];
  /** Capacidade do evento exigida. undefined = sem restrição de capacidade */
  requireCapability?: (cap: EventCapabilities) => boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

// ── definição dos grupos ───────────────────────────────────────────────────

const groups: NavGroup[] = [
  {
    label: "Operação",
    items: [
      {
        label: "Central de Operações",
        icon: Zap,
        href: "/operacoes",
        permissionAny: ["participants.view", "checkin.view", "kits.view", "wristbands.view", "wristbands.link"],
        requireCapability: (c) => c.hasCheckin || c.hasDistributableItems || c.hasWristbands,
      },
      {
        label: "Cronograma",
        icon: CalendarDays,
        href: "/painel/cronograma-entregas",
        permissionAny: ["events.view"],
      },
    ],
  },
  {
    label: "Administração",
    items: [
      {
        label: "Dashboard",
        icon: LayoutDashboard,
        href: "/painel",
        permissionAny: ["dashboard.view"],
      },
      {
        label: "Público e recorrência",
        icon: Users,
        href: "/painel/usuarios",
        permissionAny: ["dashboard.view", "participants.view"],
      },
      {
        label: "Eventos",
        icon: Layers,
        href: "/painel/eventos",
        permissionAny: ["events.view"],
      },
      {
        label: "Cadastros",
        icon: Users,
        href: "/cadastros",
        permissionAny: ["participants.view"],
      },
      {
        label: "Pedidos",
        icon: FileText,
        href: "/pedidos",
        permissionAny: ["orders.view"],
        requireCapability: (c) => c.hasOrders,
      },
      {
        label: "Financeiro",
        icon: Wallet,
        href: "/financeiro",
        permissionAny: ["finance.view"],
      },
      {
        label: "Estoque",
        icon: Shirt,
        href: "/camisetas",
        permissionAny: ["inventory.view", "kits.view"],
        requireCapability: (c) => c.hasInventory || c.hasDistributableItems,
      },
      {
        label: "Loja",
        icon: ShoppingBag,
        href: "/loja",
        permissionAny: ["store.view"],
      },
      {
        label: "Importações",
        icon: Import,
        href: "/importacoes",
        permissionAny: ["imports.view"],
      },
      {
        label: "Relatórios",
        icon: FileText,
        href: "/relatorios",
        permissionAny: ["reports.view"],
        requireCapability: (c) => c.hasEvents,
      },
      {
        label: "Cupons",
        icon: Gift,
        href: "/cupons",
        permissionAny: ["coupons.view"],
      },
      {
        label: "Fotos",
        icon: Layers,
        href: "/fotos",
        permissionAny: ["photos.view_admin"],
        requireCapability: (c) => c.hasPhotos,
      },
      {
        label: "Novo cadastro",
        icon: UserPlus,
        href: "/cadastros/novo",
        permissionAny: ["participants.create"],
      },
    ],
  },
  {
    label: "Ingressos",
    items: [
      { label: "Todos os ingressos", icon: Ticket, href: "/ingressos", permissionAny: ["participants.view", "orders.view"] },
      { label: "Emitir ingresso", icon: UserPlus, href: "/ingressos/emitir", permissionAny: ["participants.create"], requireCapability: (c) => c.registrationEnabled },
      { label: "Cortesias em lote (futuro)", icon: Gift, href: "/ingressos/cortesias", permissionAny: ["participants.create"] },
    ],
  },
  {
    label: "Organização",
    items: [
      {
        label: "Equipe",
        icon: UserRoundCog,
        href: "/painel/configuracoes/equipe",
        permissionAny: ["team.view"],
      },
      {
        label: "Configurações",
        icon: Settings,
        href: "/configuracao",
        permissionAny: ["settings.manage"],
      },
    ],
  },
];

// ── helpers de visibilidade ────────────────────────────────────────────────

function isItemVisible(
  item: NavItem,
  permissionMap: Record<string, boolean>,
  capabilities: EventCapabilities,
): boolean {
  // 1. Verificação de permissão
  const hasPerm =
    !item.permissionAny.length ||
    item.permissionAny.some((p) => Boolean(permissionMap[p]));
  if (!hasPerm) return false;

  // 2. Capacidades são agregadas na organização; nenhuma escolha de evento é implícita.
  if (item.requireCapability) {
    if (!capabilities.hasEvents) return false;
    return item.requireCapability(capabilities);
  }

  return true;
}

// ── componente ────────────────────────────────────────────────────────────

function SidebarContent() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [context, setContext] = useState<SidebarContext | null>(null);
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

  return (
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

        <nav className="space-y-6">
          {visibleGroups.map((group) => (
            <div key={group.label}>
              <p className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active =
                    pathname === item.href ||
                    (item.href !== "/painel" && pathname.startsWith(`${item.href}/`));
                  const eventScopedHref = selectedEventId && ["/operacoes", "/painel", "/cadastros", "/pedidos", "/financeiro", "/camisetas", "/loja", "/importacoes", "/relatorios", "/cupons"].includes(item.href)
                    ? `${item.href}?eventId=${encodeURIComponent(selectedEventId)}`
                    : item.href;
                  return (
                    <Link
                      key={item.label}
                      href={eventScopedHref}
                      onClick={item.href === "/cadastros" ? (event) => {
                        event.preventDefault();
                        router.push(eventScopedHref);
                      } : undefined}
                      className={`flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left text-sm font-medium transition ${
                        active
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "text-slate-300 hover:bg-slate-800/80 hover:text-white"
                      }`}
                    >
                      <span className="flex items-center gap-3">
                        <Icon size={18} />
                        {item.label}
                      </span>
                      <ChevronRight size={16} />
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Skeleton enquanto carrega */}
          {!context && (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-11 animate-pulse rounded-2xl bg-slate-800/60"
                />
              ))}
            </div>
          )}
        </nav>
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
  );
}

export function Sidebar() {
  return (
    <Suspense fallback={<aside className="hidden w-72 shrink-0 lg:block" aria-label="Carregando navegação" />}>
      <SidebarContent />
    </Suspense>
  );
}
