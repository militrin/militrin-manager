import { getOrganizationEventCapabilities } from '@/lib/admin/event-capabilities';
import { getCurrentPermissionMap } from '@/lib/admin/permissions';
import {
  ADMIN_NAV_PERMISSION_CODES,
  resolveAdministrativeLandingHref,
} from '@/lib/navigation/admin-menu';

export async function resolveAdministrativeLandingPage(): Promise<string | null> {
  const [permissionMap, capabilities] = await Promise.all([
    getCurrentPermissionMap(ADMIN_NAV_PERMISSION_CODES),
    getOrganizationEventCapabilities(),
  ]);

  return resolveAdministrativeLandingHref(permissionMap, capabilities);
}
