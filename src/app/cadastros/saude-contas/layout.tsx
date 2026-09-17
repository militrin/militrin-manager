import { requirePermission } from "@/lib/admin/permissions";
import { ACCOUNT_HEALTH_PERMISSION } from "@/lib/account/account-health";

export default async function AccountHealthLayout({ children }: { children: React.ReactNode }) {
  await requirePermission(ACCOUNT_HEALTH_PERMISSION);
  return children;
}
