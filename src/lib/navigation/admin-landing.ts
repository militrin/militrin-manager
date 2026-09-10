import { cache } from 'react';
import { getCurrentPermissionMap } from '@/lib/admin/permissions';
import { getOrganizationEventCapabilities } from '@/lib/admin/event-capabilities';
import {
  ADMIN_NAV_PERMISSION_CODES,
  resolveAdministrativeLandingHref,
} from '@/lib/navigation/admin-menu';

export const resolveAdministrativeLandingPage = cache(async (): Promise<string | null> => {
  const permissionMap = await getCurrentPermissionMap(ADMIN_NAV_PERMISSION_CODES);
  const hasAdministrativeAccess = ADMIN_NAV_PERMISSION_CODES.some((code) => permissionMap[code]);
  if (!hasAdministrativeAccess) return null;

  const capabilities = await getOrganizationEventCapabilities();
  return resolveAdministrativeLandingHref(permissionMap, capabilities);
});
