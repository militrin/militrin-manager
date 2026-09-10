import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/request-auth';
import { getCurrentPermissionMap, hasPermission } from '@/lib/admin/permissions';

/**
 * Permissoes que representam acesso real a pelo menos uma area operacional.
 * Esta lista e o contrato compartilhado entre entrada, navegacao e guard.
 */
export const ADMINISTRATIVE_PANEL_PERMISSION_CODES = [
  'dashboard.view',
  'dashboard.integrity.view',
  'dashboard.people.view',
  'dashboard.operations.view',
  'dashboard.inventory.view',
  'dashboard.finance.view',
  'participants.view',
  'participants.create',
  'orders.view',
  'events.view',
  'kits.view',
  'kits.deliver',
  'checkin.view',
  'checkin.scan',
  'inventory.view',
  'photos.view_admin',
  'categories.view',
  'batches.view',
  'coupons.view',
  'finance.view',
  'reports.view',
  'imports.view',
  'settings.manage',
  'team.view',
  'wristbands.view',
  'wristbands.link',
  'store.view',
  'store.deliver',
  'sponsors.view',
  'feedback.view',
  'integrity.view',
  'finance.confirm_payment',
] as const;

export async function canAccessAdministrativePanel(userId?: string) {
  const currentUser = await getCurrentUser();
  if (userId && currentUser?.id && userId !== currentUser.id) {
    const results = await Promise.all(
      ADMINISTRATIVE_PANEL_PERMISSION_CODES.map((code) => hasPermission(code, userId)),
    );
    return results.some(Boolean);
  }

  const permissionMap = await getCurrentPermissionMap([...ADMINISTRATIVE_PANEL_PERMISSION_CODES]);
  return ADMINISTRATIVE_PANEL_PERMISSION_CODES.some((code) => permissionMap[code]);
}

export async function requireAdministrativePanelAccess() {
  if (!await canAccessAdministrativePanel()) redirect('/acesso-negado');
}
