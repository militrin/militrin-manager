import { requirePermission } from '@/lib/admin/permissions';

export default async function PainelLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('dashboard.view');
  return <>{children}</>;
}
