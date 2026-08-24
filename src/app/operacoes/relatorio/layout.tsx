import { requirePermission } from "@/lib/admin/permissions";

// Gate estrito, alem do gate solto ja aplicado por src/app/operacoes/layout.tsx.
// Fica fora de /relatorios (gateado por reports.view, que Operacional nao tem
// hoje -- ver 20260879000000_consolidate_admin_roles.sql) de proposito: assim
// nenhuma permissao existente precisa mudar pra Operacional acessar so este
// relatorio especifico.
export default async function OperacoesRelatorioLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("operations.view_report");
  return <>{children}</>;
}
