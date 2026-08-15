import { requirePermission } from "@/lib/admin/permissions";

export default async function OperacoesLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("participants.view");

  return <>{children}</>;
}
