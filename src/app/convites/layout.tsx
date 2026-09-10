import { requirePermission } from '@/lib/admin/permissions';

export default async function ConvitesLayout({ children }: { children: React.ReactNode }) {
  await requirePermission('invites.view');
  return children;
}
