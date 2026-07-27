import { requirePermission } from "@/lib/admin/permissions";

export default async function InscricoesLayout({ children }: { children: React.ReactNode }) {
  await requirePermission("participants.view");

  return <>{children}</>;
}
