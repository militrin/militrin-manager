"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import {
  AlertTriangle,
  ChevronRight,
  FileText,
  Gift,
  Import,
  LayoutDashboard,
  Layers,
  PackageCheck,
  Settings,
  Shirt,
  UserPlus,
  UserRoundCog,
  Users,
  Wallet,
} from "lucide-react";
import { getSidebarPermissionMapAction } from "./sidebar-actions";

const navigation = [
  { label: "Dashboard", icon: LayoutDashboard, href: "/painel", permissionAny: ["dashboard.view"] },
  { label: "Eventos", icon: Layers, href: "/painel/eventos", permissionAny: ["events.view"] },
  { label: "Participantes", icon: Users, href: "/inscricoes", permissionAny: ["participants.view"] },
  { label: "Pedidos", icon: FileText, href: "/inscricoes", permissionAny: ["orders.view"] },
  { label: "Financeiro", icon: Wallet, href: "/financeiro", permissionAny: ["finance.view"] },
  { label: "Estoque", icon: Shirt, href: "/camisetas", permissionAny: ["inventory.view"] },
  { label: "Entrega de kits", icon: PackageCheck, href: "/retirada", permissionAny: ["kits.view"] },
  { label: "Cronograma de Entregas", icon: PackageCheck, href: "/painel/cronograma-entregas", permissionAny: ["kits.view"] },
  { label: "Check-in", icon: PackageCheck, href: "/retirada", permissionAny: ["checkin.view"] },
  { label: "Fotos", icon: Layers, href: "/fotos", permissionAny: ["photos.view_admin"] },
  { label: "Importações", icon: Import, href: "/importacoes", permissionAny: ["imports.view"] },
  { label: "Relatórios", icon: FileText, href: "/inscricoes", permissionAny: ["reports.view"] },
  { label: "Cupons", icon: Gift, href: "/cupons", permissionAny: ["coupons.view"] },
  { label: "Equipe", icon: UserRoundCog, href: "/painel/configuracoes/equipe", permissionAny: ["team.view"] },
  { label: "Configurações", icon: Settings, href: "/configuracao", permissionAny: ["settings.manage"] },
  { label: "Nova inscrição", icon: UserPlus, href: "/inscricoes/nova", permissionAny: ["participants.create"] },
];

export function Sidebar() {
  const pathname = usePathname();
  const [permissionMap, setPermissionMap] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    let mounted = true;
    getSidebarPermissionMapAction()
      .then((map) => {
        if (mounted) setPermissionMap(map);
      })
      .catch(() => {
        if (mounted) setPermissionMap({});
      });

    return () => {
      mounted = false;
    };
  }, []);

  const visibleNavigation = useMemo(() => {
    if (!permissionMap) return [];

    return navigation.filter((item) => {
      if (!item.permissionAny || item.permissionAny.length === 0) return true;
      return item.permissionAny.some((permissionCode) => Boolean(permissionMap[permissionCode]));
    });
  }, [permissionMap]);

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

        <nav className="space-y-2">
          {visibleNavigation.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.label}
                href={item.href}
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
        </nav>
      </div>

      <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
        <div className="mb-2 flex items-center gap-2">
          <AlertTriangle size={16} />
          <span className="font-semibold">Navegação protegida</span>
        </div>
        <p>Os itens do menu são exibidos conforme suas permissões administrativas.</p>
      </div>
    </aside>
  );
}
