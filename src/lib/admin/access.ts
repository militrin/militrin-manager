import { createServerSupabaseClient } from '@/lib/supabase/server';
import { hasPermission } from '@/lib/admin/permissions';

export async function getAdminAccessContext() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const hasDashboardPermission = await hasPermission('dashboard.view');
  const canViewFinancial = await hasPermission('finance.view_amounts');
  const isAdmin = hasDashboardPermission;

  return {
    user,
    isAdmin,
    canViewFinancial,
  };
}
