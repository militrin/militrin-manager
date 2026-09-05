import { requireAdministrativePanelAccess } from "@/lib/admin/panel-access";
import { runAsaasLivePreflightDiag } from "@/lib/payments/asaas-live-preflight-diag";

export const dynamic = "force-dynamic";

export default async function AsaasLivePreflightDiagPage() {
  await requireAdministrativePanelAccess();
  let result: unknown;
  try {
    result = await runAsaasLivePreflightDiag();
  } catch {
    result = { error: "Falha no diagnostico." };
  }

  return (
    <pre style={{ padding: 24, whiteSpace: "pre-wrap" }}>
      {JSON.stringify(result, null, 2)}
    </pre>
  );
}
