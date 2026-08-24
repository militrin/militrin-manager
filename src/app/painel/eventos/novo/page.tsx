import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { EventDataForm } from "../[id]/event-data-form";
import { requirePermission } from "@/lib/admin/permissions";

export default async function NewEventPage() {
  await requirePermission("events.create");
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Novo evento" subtitle="Etapa 1 de 7: dados básicos do evento" breadcrumbs={[{label:"Início",href:"/painel"},{label:"Eventos",href:"/painel/eventos"},{label:"Novo evento"}]} backHref="/painel/eventos" fallbackHref="/painel/eventos" />
          <SectionCard title="Dados do evento" description="Preencha os dados básicos. As demais etapas (categorias, lotes, adicionais...) ficam disponíveis depois de salvar.">
            <EventDataForm mode="create" />
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
