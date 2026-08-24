"use server";

import { redirect } from 'next/navigation';
import { getCurrentPermissionMap } from '@/lib/admin/permissions';
import { getOrganizationEventCapabilities, type EventCapabilities } from '@/lib/admin/event-capabilities';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { ADMIN_NAV_PERMISSION_CODES } from '@/lib/navigation/admin-menu';

export type SidebarContext = {
  permissionMap: Record<string, boolean>;
  capabilities: EventCapabilities;
};

export async function getSidebarContextAction(): Promise<SidebarContext> {
  const [permissionMap, capabilities] = await Promise.all([
    getCurrentPermissionMap(ADMIN_NAV_PERMISSION_CODES),
    getOrganizationEventCapabilities(),
  ]);
  return { permissionMap, capabilities };
}
/** @deprecated use getSidebarContextAction */
export async function getSidebarPermissionMapAction() {
  return getCurrentPermissionMap(ADMIN_NAV_PERMISSION_CODES);
}

export async function signOutAdministrativePanelAction() {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error('Não foi possível encerrar a sessão.');
  redirect('/entrar');
}
