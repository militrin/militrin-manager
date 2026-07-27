import { requirePermission } from '@/lib/admin/permissions';

export default async function ConfiguracoesLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('team.view');
  return <>{children}</>;
}
