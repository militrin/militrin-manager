import {
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  FileText,
  Gift,
  Import,
  LayoutDashboard,
  Bolt,
  Layers,
  MessageSquareWarning,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Shirt,
  ShoppingBag,
  Tag,
  Ticket,
  UserPlus,
  UserRoundCog,
  Users,
  Wallet,
  Zap,
} from "lucide-react";
import type { EventCapabilities } from "@/lib/admin/event-capabilities";

// Fonte unica do menu administrativo -- consumida pela sidebar desktop
// (Sidebar.tsx) E pela navegacao mobile (header/drawer/bottom nav, mesmo
// arquivo). Nenhum dos dois define sua propria lista de rotas/permissoes;
// os dois leem exatamente este array, entao nunca podem divergir.

export type AdminNavItem = {
  label: string;
  icon: React.ElementType;
  href: string;
  /** Permissões: basta ter ao menos uma */
  permissionAny: string[];
  /** Permissoes cumulativas: todas sao obrigatorias. */
  permissionAll?: string[];
  /** Capacidade do evento exigida. undefined = sem restrição de capacidade */
  requireCapability?: (cap: EventCapabilities) => boolean;
  /** Prioridade da rota como entrada administrativa. Menor = preferida. */
  landingPriority?: number;
};

export type AdminNavGroup = {
  label: string;
  items: AdminNavItem[];
};

export const adminNavGroups: AdminNavGroup[] = [
  {
    label: "Operação",
    items: [
      {
        label: "Central de Operações",
        icon: Zap,
        href: "/operacoes",
        permissionAny: ["participants.view", "checkin.view", "kits.view", "wristbands.view", "wristbands.link"],
        requireCapability: (c) => c.hasCheckin || c.hasDistributableItems || c.hasWristbands,
        landingPriority: 20,
      },
      {
        label: "Modo Turbo",
        icon: Bolt,
        href: "/operacoes/turbo",
        // Mesma lista de TURBO_ENTRY_PERMISSIONS em operacoes/actions.ts --
        // so entra quem tem alguma permissao real de operacao Turbo
        // (ingresso OU produto de loja).
        permissionAny: ["kits.deliver", "checkin.scan", "store.deliver"],
        requireCapability: (c) => c.hasCheckin || c.hasDistributableItems,
        landingPriority: 21,
      },
      {
        label: "Ver pulseira vinculada",
        icon: Tag,
        href: "/operacoes/pulseira",
        permissionAny: ["wristbands.view"],
        requireCapability: (c) => c.hasWristbands,
        landingPriority: 22,
      },
      {
        label: "Solicitações de alteração",
        icon: ClipboardCheck,
        href: "/operacoes/solicitacoes",
        // Mesma permissao que review_ticket_item_change_request ja exige no
        // backend (fluxo de aprovacao de alteracao de item do kit, ex.:
        // tamanho de camiseta) -- ver auditoria do fluxo de aprovacao.
        permissionAny: ["kits.deliver"],
        requireCapability: (c) => c.hasDistributableItems,
        landingPriority: 22.5,
      },
      {
        label: "Relatório de Operações",
        icon: ClipboardList,
        href: "/operacoes/relatorio",
        permissionAny: ["operations.view_report"],
        landingPriority: 23,
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
        permissionAny: ["dashboard.integrity.view", "dashboard.people.view", "dashboard.operations.view", "dashboard.inventory.view", "dashboard.finance.view"],
        landingPriority: 10,
      },
      {
        label: "Integridade",
        icon: ShieldAlert,
        href: "/painel/integridade",
        permissionAny: ["integrity.view"],
      },
      {
        label: "Público e recorrência",
        icon: Users,
        href: "/painel/usuarios",
        permissionAny: [],
        permissionAll: ["dashboard.people.view", "participants.view"],
      },
      {
        label: "Eventos",
        icon: Layers,
        href: "/painel/eventos",
        permissionAny: ["events.view"],
        landingPriority: 40,
      },
      {
        label: "Cadastros",
        icon: Users,
        href: "/cadastros",
        permissionAny: ["participants.view"],
        landingPriority: 30,
      },
      {
        label: "Pedidos",
        icon: FileText,
        href: "/pedidos",
        permissionAny: ["orders.view"],
        requireCapability: (c) => c.hasOrders,
        landingPriority: 50,
      },
      {
        label: "Financeiro",
        icon: Wallet,
        href: "/financeiro",
        permissionAny: ["finance.view"],
        landingPriority: 60,
      },
      {
        label: "Estoque",
        icon: Shirt,
        href: "/camisetas",
        permissionAny: ["inventory.view", "kits.view"],
        requireCapability: (c) => c.hasInventory || c.hasDistributableItems,
        landingPriority: 70,
      },
      {
        label: "Loja",
        icon: ShoppingBag,
        href: "/loja",
        permissionAny: ["store.view"],
        landingPriority: 80,
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
        landingPriority: 90,
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
        label: "Equipe e permissões",
        icon: UserRoundCog,
        href: "/painel/configuracoes/equipe",
        permissionAny: ["team.view"],
        landingPriority: 100,
      },
      {
        label: "Patrocinadores",
        icon: ShieldCheck,
        href: "/painel/patrocinadores",
        permissionAny: ["sponsors.view"],
      },
      {
        label: "Feedbacks",
        icon: MessageSquareWarning,
        href: "/painel/feedbacks",
        permissionAny: ["feedback.view"],
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

// Rotas que recebem ?eventId= propagado do contexto atual (evento
// selecionado em outra pagina). "/operacoes/turbo" fica DE PROPOSITO fora
// desta lista: o Modo Turbo sempre exige escolher o evento na propria rota
// (sessionStorage por operacao, nunca herdado da URL de outra pagina) --
// ver TurboRouteClient.tsx.
export const EVENT_SCOPED_HREFS = [
  "/operacoes",
  "/painel",
  "/cadastros",
  "/operacoes/pulseira",
  "/pedidos",
  "/financeiro",
  "/camisetas",
  "/loja",
  "/importacoes",
  "/relatorios",
  "/cupons",
];

export function isAdminNavItemVisible(
  item: AdminNavItem,
  permissionMap: Record<string, boolean>,
  capabilities: EventCapabilities,
): boolean {
  // 1. Verificação de permissão
  const hasPerm =
    !item.permissionAny.length ||
    item.permissionAny.some((p) => Boolean(permissionMap[p]));
  if (!hasPerm) return false;
  if (item.permissionAll?.some((p) => !permissionMap[p])) return false;

  // 2. Capacidades são agregadas na organização; nenhuma escolha de evento é implícita.
  if (item.requireCapability) {
    if (!capabilities.hasEvents) return false;
    return item.requireCapability(capabilities);
  }

  return true;
}

export function findAdminNavItem(href: string): AdminNavItem | null {
  for (const group of adminNavGroups) {
    const found = group.items.find((item) => item.href === href);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve a primeira rota administrativa que o usuario pode realmente abrir.
 * As permissoes, capacidades, rotas e prioridades permanecem na mesma fonte
 * que alimenta a navegacao desktop e mobile.
 */
export function resolveAdministrativeLandingHref(
  permissionMap: Record<string, boolean>,
  capabilities: EventCapabilities,
): string | null {
  const items = adminNavGroups.flatMap((group) => group.items);
  const firstVisible = items
    .map((item, menuIndex) => ({ item, menuIndex }))
    .filter(({ item }) => isAdminNavItemVisible(item, permissionMap, capabilities))
    .sort((a, b) =>
      (a.item.landingPriority ?? 1_000 + a.menuIndex) -
      (b.item.landingPriority ?? 1_000 + b.menuIndex),
    )[0];

  return firstVisible?.item.href ?? null;
}

export const ADMIN_NAV_PERMISSION_CODES = Array.from(
  new Set(adminNavGroups.flatMap((group) => group.items.flatMap((item) => [...item.permissionAny, ...(item.permissionAll ?? [])]))),
);
