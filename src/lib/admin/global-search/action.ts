"use server";

import { canAccessAdministrativePanel } from "@/lib/admin/panel-access.ts";
import { getCurrentPermissionMap } from "@/lib/admin/permissions.ts";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization.ts";
import { createServerSupabaseClient } from "@/lib/supabase/server.ts";
import { executeGlobalSearch } from "./search.ts";
import type { GlobalSearchResult } from "./types.ts";

export async function searchAdminGloballyAction(query: string): Promise<GlobalSearchResult> {
  if (!await canAccessAdministrativePanel()) {
    return { status: "error", message: "Não foi possível realizar a busca. Tente novamente." };
  }

  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) {
    return { status: "error", message: "Selecione uma organização para buscar." };
  }

  const permissionMap = await getCurrentPermissionMap([
    "participants.view",
    "orders.view",
    "wristbands.view",
    "finance.view_amounts",
  ]);

  const supabase = await createServerSupabaseClient();
  return executeGlobalSearch(query, {
    supabase,
    organizationId: organization.id,
    permissions: {
      participantsView: Boolean(permissionMap["participants.view"]),
      ordersView: Boolean(permissionMap["orders.view"]),
      wristbandsView: Boolean(permissionMap["wristbands.view"]),
      canViewAmounts: Boolean(permissionMap["finance.view_amounts"]),
    },
  });
}
