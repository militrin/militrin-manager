import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdminPageHeader } from "@/components/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { getCurrentPermissionMap } from "@/lib/admin/permissions";
import { REPORT_CATALOG } from "@/lib/reports/catalog";
import { ReportsExplorer } from "./reports-explorer";

export default async function RelatoriosPage() {
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) {
    return <main className="p-8 text-slate-200">Selecione uma organização para visualizar os relatórios.</main>;
  }

  const distinctPermissions = Array.from(new Set(REPORT_CATALOG.flatMap((report) => (Array.isArray(report.permission) ? report.permission : [report.permission]))));
  const permissionMap = await getCurrentPermissionMap(distinctPermissions);
  const visibleCatalog = REPORT_CATALOG.filter((report) => {
    const codes = Array.isArray(report.permission) ? report.permission : [report.permission];
    return codes.some((code) => permissionMap[code]);
  });

  const supabase = await createServerSupabaseClient();
  const { data: events } = await supabase.from("events").select("id,name").eq("organization_id", organization.id).order("starts_at", { ascending: false });

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <TopBar title="Relatórios" subtitle={organization.name} />
        <main className="mx-auto w-full max-w-7xl space-y-6 px-6 py-6">
          <AdminPageHeader title="Central de relatórios" subtitle="Selecione um relatório, ajuste os filtros e gere a prévia. Exporte em PDF ou Excel quando precisar." />
          <ReportsExplorer catalog={visibleCatalog} events={(events ?? []).map((event) => ({ id: String(event.id), name: String(event.name) }))} />
        </main>
      </div>
    </div>
  );
}
