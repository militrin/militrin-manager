import { requirePermission } from "@/lib/admin/permissions";

export default async function RelatoriosLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("reports.view");
  return <>{children}</>;
}
