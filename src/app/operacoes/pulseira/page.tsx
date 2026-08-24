import { requirePermission, hasPermission } from "@/lib/admin/permissions";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { WristbandLookupClient } from "./WristbandLookupClient";

export default async function OperacoesPulseiraPage() {
  await requirePermission("wristbands.view");

  const organization = (await getCurrentOrganizationContext()).organization;
  const canUnlink = await hasPermission("wristbands.unlink");

  let events: Array<{ id: string; name: string }> = [];
  if (organization?.id) {
    const supabase = await createServerSupabaseClient();
    const { data } = await supabase
      .from("events")
      .select("id,name")
      .eq("organization_id", organization.id)
      .order("is_active", { ascending: false })
      .order("starts_at", { ascending: false });
    events = (data ?? []).map((event) => ({ id: String(event.id), name: String(event.name) }));
  }

  return <WristbandLookupClient events={events} canUnlink={canUnlink} />;
}
