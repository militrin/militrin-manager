import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DeliveryScheduleManager } from "@/app/painel/eventos/[id]/delivery-schedule-manager";

async function getKitDeliveries() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from("kit_delivery_schedule")
    .select("id, delivery_at, city, location, sort_order, is_active")
    .order("sort_order", { ascending: true })
    .order("delivery_at", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row: {
    id: string;
    delivery_at: string;
    city: string;
    location: string;
    sort_order: number;
    is_active: boolean;
  }) => ({
    id: String(row.id),
    delivery_at: String(row.delivery_at),
    city: String(row.city ?? ""),
    location: String(row.location ?? ""),
    sort_order: Number(row.sort_order ?? 0),
    is_active: Boolean(row.is_active),
  }));
}

export default async function AdminDeliverySchedulePage() {
  const kitDeliveries = await getKitDeliveries();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Cronograma de Entregas" subtitle="Gestao das datas, cidades e locais de entrega de kits" />
          <SectionCard title="Cronograma de Entregas" description="Cadastre e organize as proximas entregas de kits.">
            <DeliveryScheduleManager initialRows={kitDeliveries} />
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
