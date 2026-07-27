import { requirePermission } from '@/lib/admin/permissions';

export default async function CamisetasLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('inventory.view');
  return <>{children}</>;
}
