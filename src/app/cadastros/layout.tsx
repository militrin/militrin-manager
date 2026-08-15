import { requirePermission } from '@/lib/admin/permissions';

export default async function CadastrosLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('participants.view');
  return children;
}
