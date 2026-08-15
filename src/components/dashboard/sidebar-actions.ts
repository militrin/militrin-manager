"use server";

import { redirect } from 'next/navigation';
import { getCurrentPermissionMap } from '@/lib/admin/permissions';
import { getOrganizationEventCapabilities, type EventCapabilities } from '@/lib/admin/event-capabilities';
import { createServerSupabaseClient } from '@/lib/supabase/server';

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
  'wristbands.view',
  'wristbands.link',
  'store.view',
];

export type SidebarContext = {
  permissionMap: Record<string, boolean>;
  capabilities: EventCapabilities;
};

export async function getSidebarContextAction(): Promise<SidebarContext> {
  const [permissionMap, capabilities] = await Promise.all([
    getCurrentPermissionMap(sidebarPermissionCodes),
    getOrganizationEventCapabilities(),
  ]);
  return { permissionMap, capabilities };
}
/** @deprecated use getSidebarContextAction */
export async function getSidebarPermissionMapAction() {
  return getCurrentPermissionMap(sidebarPermissionCodes);
}

export async function signOutAdministrativePanelAction() {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error('Não foi possível encerrar a sessão.');
  redirect('/entrar');
}
