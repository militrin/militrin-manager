import { requireAdministrativePanelAccess } from '@/lib/admin/panel-access';

export default async function PainelLayout({ children }: { children: React.ReactNode }) {
  await requireAdministrativePanelAccess();
  return <>{children}</>;
}
