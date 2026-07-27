import { requirePermission } from '@/lib/admin/permissions';

export default async function LotesLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('batches.view');
  return <>{children}</>;
}
