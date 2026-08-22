import {
  CalendarDays,
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
  /** Capacidade do evento exigida. undefined = sem restrição de capacidade */
  requireCapability?: (cap: EventCapabilities) => boolean;
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
      },
      {
        label: "Ver pulseira vinculada",
        icon: Tag,
        href: "/operacoes/pulseira",
        permissionAny: ["wristbands.view"],
        requireCapability: (c) => c.hasWristbands,
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
        label: "Integridade",
        icon: ShieldAlert,
        href: "/painel/integridade",
        permissionAny: ["integrity.view"],
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
        label: "Equipe e permissões",
        icon: UserRoundCog,
        href: "/painel/configuracoes/equipe",
        permissionAny: ["team.view"],
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
