import { requireAnyPermission } from '@/lib/admin/permissions';

// Redirect de compatibilidade: o gate precisa ser o mesmo da Central
// (/operacoes/layout.tsx). A tela antiga exigia kits.view|checkin.view e
// barraria bookmarks de operadores que hoje entram pela Central.
export default async function RetiradaLayout({ children }: { children: React.ReactNode }) {
  await requireAnyPermission([
    'participants.view',
    'checkin.view',
    'kits.view',
    'wristbands.view',
    'wristbands.link',
    'kits.deliver',
    'checkin.scan',
    'store.deliver',
  ]);
  return <>{children}</>;
}
