import { requirePermission } from '@/lib/admin/permissions';

export default async function ConfiguracaoLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('settings.manage');
  return <>{children}</>;
}
