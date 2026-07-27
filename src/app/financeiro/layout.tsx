import { requirePermission } from '@/lib/admin/permissions';

export default async function FinanceiroLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('finance.view');
  return <>{children}</>;
}
