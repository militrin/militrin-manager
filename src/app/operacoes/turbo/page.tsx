import { requireAnyPermission } from "@/lib/admin/permissions";
import { TurboRouteClient } from "./TurboRouteClient";

// Gate estrito da rota (nao so o gate solto de OperacoesLayout): so entra
// quem tem alguma permissao de operacao Turbo de verdade. Mesma lista de
// TURBO_ENTRY_PERMISSIONS em actions.ts/getTurboEventsAction -- se um dia
// crescer, atualizar os dois.
export default async function OperacoesTurboPage() {
  await requireAnyPermission(["kits.deliver", "checkin.scan", "store.deliver"]);

  return <TurboRouteClient />;
}
