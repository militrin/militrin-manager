import { createServerSupabaseClient } from '@/lib/supabase/server';
import { hasPermission } from '@/lib/admin/permissions';

function parseAllowlist(value: string | undefined) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

export async function getAdminAccessContext() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const userEmail = String(user?.email ?? '').trim().toLowerCase();
  const adminAllowlist = parseAllowlist(process.env.ADMIN_ALLOWLIST_EMAILS);

  const hasDashboardPermission = await hasPermission('dashboard.view');
  const canViewFinancial = await hasPermission('finance.view_amounts');

  // Compatibilidade temporaria para ambientes ainda sem migration aplicada.
  const fallbackIsAdmin = Boolean(user?.id) && (adminAllowlist.length === 0 || adminAllowlist.includes(userEmail));
  const isAdmin = hasDashboardPermission || fallbackIsAdmin;

  return {
    user,
    isAdmin,
    canViewFinancial,
  };
}
