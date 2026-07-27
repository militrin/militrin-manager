import { requireAnyPermission } from '@/lib/admin/permissions';

export default async function RetiradaLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission(['kits.view', 'checkin.view']);
  return <>{children}</>;
}
