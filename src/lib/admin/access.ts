import { createServerSupabaseClient } from '@/lib/supabase/server';
import { hasPermission } from '@/lib/admin/permissions';
import { DASHBOARD_SECTION_PERMISSION_CODES } from '@/lib/dashboard/dashboard-permissions';

export async function getAdminAccessContext() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const hasDashboardPermission = (await Promise.all(DASHBOARD_SECTION_PERMISSION_CODES.map((code) => hasPermission(code)))).some(Boolean);
  const canViewFinancial = await hasPermission('finance.view_amounts');
  const isAdmin = hasDashboardPermission;

  return {
    user,
    isAdmin,
    canViewFinancial,
  };
}
