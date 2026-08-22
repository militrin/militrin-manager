import { requireAnyPermission } from "@/lib/admin/permissions";

// Gate solto de "tem algum motivo de estar em /operacoes ou numa das
// subareas" (Central, Modo Turbo, Ver pulseira vinculada) -- cada
// pagina/action embaixo (actions.ts, /operacoes/turbo, /operacoes/pulseira)
// ainda faz sua PROPRIA checagem estrita da permissao especifica daquela
// operacao. Union de: permissionAny da Central de Operacoes no Sidebar +
// TURBO_ENTRY_PERMISSIONS (actions.ts) + wristbands.view (pulseira).
export default async function OperacoesLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission([
    "participants.view",
    "checkin.view",
    "kits.view",
    "wristbands.view",
    "wristbands.link",
    "kits.deliver",
    "checkin.scan",
    "store.deliver",
  ]);

  return <>{children}</>;
}
