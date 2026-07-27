import { requirePermission } from '@/lib/admin/permissions';

export default async function CategoriasLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('categories.view');
  return <>{children}</>;
}
