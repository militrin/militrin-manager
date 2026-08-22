import { requirePermission } from "@/lib/admin/permissions";
import { WristbandLookupClient } from "./WristbandLookupClient";

export default async function OperacoesPulseiraPage() {
  await requirePermission("wristbands.view");

  return <WristbandLookupClient />;
}
