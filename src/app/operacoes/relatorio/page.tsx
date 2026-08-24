import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { AdminPageHeader } from "@/components/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { REPORT_CATALOG } from "@/lib/reports/catalog";
import { ReportsExplorer } from "@/app/relatorios/reports-explorer";

// Mesmo motor de /relatorios (catalogo, runReport, export PDF/XLSX/CSV),
// so filtrado pra categoria "operacoes" e vivendo fora do gate de
// reports.view -- ver layout.tsx desta rota.
export default async function OperacoesRelatorioPage() {
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) {
    return <main className="p-8 text-slate-200">Selecione uma organização para visualizar o relatório.</main>;
  }

  const catalog = REPORT_CATALOG.filter((report) => report.category === "operacoes");

  const supabase = await createServerSupabaseClient();
  const { data: events } = await supabase.from("events").select("id,name").eq("organization_id", organization.id).order("starts_at", { ascending: false });

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <TopBar title="Relatório de Operações" subtitle={organization.name} />
        <main className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6">
          <AdminPageHeader
            title="Histórico de Operações e Snapshot de Contingência"
            subtitle="Log imutável de ações (kit, check-in, pulseira, camiseta, titular) e uma foto do estado atual para usar offline no dia do evento."
          />
          <ReportsExplorer catalog={catalog} events={(events ?? []).map((event) => ({ id: String(event.id), name: String(event.name) }))} />
        </main>
      </div>
    </div>
  );
}
