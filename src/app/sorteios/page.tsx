import { Sidebar } from "@/components/dashboard/Sidebar";
import { AdminPageHeader } from "@/components/admin";
import { requireAdministrativePanelAccess } from "@/lib/admin/panel-access";
import { SorteioApp } from "@/components/sorteios/SorteioApp";
import { getInstagramStatus, loadLatestGiveawaySession } from "./actions";

export default async function SorteiosPage() {
  await requireAdministrativePanelAccess();
  const [bootstrap, instagramStatus] = await Promise.all([
    loadLatestGiveawaySession(),
    getInstagramStatus(),
  ]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-3 py-4 text-slate-100 sm:px-5 lg:px-6">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4 lg:flex-row">
        <Sidebar />
        <div className="min-w-0 flex-1 space-y-4">
          <AdminPageHeader compact title="Sorteador Militrin 🍀" subtitle="Sorteio oficial • 1 KIT MILITRIN" />
          <SorteioApp initialSession={bootstrap.session} persistenceAvailable={bootstrap.persistence === "available"} initialInstagramStatus={instagramStatus} />
        </div>
      </div>
    </main>
  );
}
