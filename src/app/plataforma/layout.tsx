import { requirePlatformAccess } from '@/lib/organizations/access';

export default async function PlataformaLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAccess();
  return <>{children}</>;
}
