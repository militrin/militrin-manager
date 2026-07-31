"use server";

import { getCurrentPermissionMap } from '@/lib/admin/permissions';

const sidebarPermissionCodes = [
  'dashboard.view',
  'participants.view',
  'participants.create',
  'orders.view',
  'events.view',
  'kits.view',
  'checkin.view',
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
];

export async function getSidebarPermissionMapAction() {
  return getCurrentPermissionMap(sidebarPermissionCodes);
}
