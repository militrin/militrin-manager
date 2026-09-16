import { cache } from 'react';
import { getCurrentUser } from '@/lib/auth/request-auth';
import { getCurrentPermissionMap } from '@/lib/admin/permissions';
import { getOrganizationEventCapabilities } from '@/lib/admin/event-capabilities';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import {
  ADMIN_NAV_PERMISSION_CODES,
  resolveAdministrativeLandingHref,
} from '@/lib/navigation/admin-menu';

export const resolveAdministrativeLandingPage = cache(async (): Promise<string | null> => {
  const user = await getCurrentUser();
  if (!user?.id) return null;

  const supabase = await createServerSupabaseClient();
  const [{ data: member }, { data: platformUser }] = await Promise.all([
    supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('platform_users')
      .select('user_id')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .maybeSingle(),
  ]);

  if (!member && !platformUser) return null;

  const permissionMap = await getCurrentPermissionMap(ADMIN_NAV_PERMISSION_CODES);
  const hasAdministrativeAccess = ADMIN_NAV_PERMISSION_CODES.some((code) => permissionMap[code]);
  if (!hasAdministrativeAccess) return null;

  const capabilities = await getOrganizationEventCapabilities();
  return resolveAdministrativeLandingHref(permissionMap, capabilities);
});
