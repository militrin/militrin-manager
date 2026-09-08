import "server-only";
import { requireAdministrativePanelAccess } from "@/lib/admin/panel-access";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";

export async function requireGiveawayAdminContext() {
  await requireAdministrativePanelAccess();
  const [{ organization }, supabase] = await Promise.all([getCurrentOrganizationContext(), createServerSupabaseClient()]);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !organization) throw new Error("Usuario ou organizacao ativa nao encontrados.");
  return { user, organization, admin: createServiceRoleSupabaseClient() };
}
