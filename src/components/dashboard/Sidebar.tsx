import Link from "next/link";
import {
  AlertTriangle,
  ChevronRight,
  FileText,
  LayoutDashboard,
  PackageCheck,
  Settings,
  Shirt,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";

const navigation = [
  { label: "Dashboard", icon: LayoutDashboard, active: true, href: "/" },
  { label: "Nova inscrição", icon: UserPlus, href: "/inscricoes/nova" },
  { label: "Inscritos", icon: Users, href: "/inscricoes" },
  { label: "Retirada de kits", icon: PackageCheck, href: "/retirada" },
  { label: "Camisetas", icon: Shirt, href: "/camisetas" },
  { label: "Financeiro", icon: Wallet, href: "/inscricoes" },
  { label: "Relatórios", icon: FileText, href: "/inscricoes" },
  { label: "Configurações", icon: Settings, href: "/configuracao" },
];

export function Sidebar() {
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
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.label}
                href={item.href}
                className={`flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left text-sm font-medium transition ${
                  item.active
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
          <span className="font-semibold">Estoque baixo</span>
        </div>
        <p>Modelos Babylook PP e Camiseta EXGG precisam de reposição.</p>
      </div>
    </aside>
  );
}
