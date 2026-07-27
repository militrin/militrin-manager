import { requirePermission } from '@/lib/admin/permissions';

export default async function CuponsLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('coupons.view');
  return <>{children}</>;
}
