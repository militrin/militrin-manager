import { isEmailConfirmed } from "@/lib/account/email-confirmation";
import { getAdminAccessContext } from "@/lib/admin/access";
import { AdminPageHeader } from "@/components/admin";
import { runAsaasAccountIdentityDiag } from "@/lib/payments/asaas-account-identity-diag";

export const dynamic = "force-dynamic";

export default async function DiagnosticoAsaasContaPage() {
  const access = await getAdminAccessContext();
  if (!access.user || !access.isAdmin || !isEmailConfirmed(access.user)) {
    return (
      <div className="p-6 text-slate-200">
        Acesso negado.
      </div>
    );
  }

  const result = await runAsaasAccountIdentityDiag();
  const report = [
    "PIX:",
    `- auth: ${result.pix.auth}`,
    `- account: ${result.pix.account ?? "null"}`,
    `- commercialSite: ${result.pix.commercialSite ?? "null"}`,
    result.pix.companyName ? `- companyName: ${result.pix.companyName}` : null,
    "",
    "CARD:",
    `- auth: ${result.card.auth}`,
    `- account: ${result.card.account ?? "null"}`,
    `- commercialSite: ${result.card.commercialSite ?? "null"}`,
    result.card.companyName ? `- companyName: ${result.card.companyName}` : null,
    "",
    "CONTA CORRETA PARA O MILITRIN:",
    `- ${result.verdict}`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  return (
    <div className="space-y-6 p-6">
      <AdminPageHeader
        title="Diagnóstico Asaas — identidade da conta"
        subtitle="Temporário. Somente GET read-only. Sem secrets."
        fallbackHref="/painel"
      />
      <pre className="overflow-auto rounded-2xl border border-slate-800 bg-slate-950 p-4 text-sm text-slate-100">
        {report}
      </pre>
    </div>
  );
}
