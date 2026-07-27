import { requirePermission } from '@/lib/admin/permissions';

export default async function ImportacoesLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('imports.view');
  return <>{children}</>;
}
