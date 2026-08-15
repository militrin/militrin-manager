import { requirePermission } from "@/lib/admin/permissions";

export default async function PedidosLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("orders.view");
  return <>{children}</>;
}
