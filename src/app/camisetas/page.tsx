import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ShirtStockTable } from "@/components/mvp/ShirtStockTable";

type ShirtInventoryRow = {
  id: string;
  events?: { name?: string | null } | null;
  shirt_type: string;
  shirt_size: string;
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
};

async function getStock() {
  const supabase = await createServerSupabaseClient();
  const { data: activeEvent } = await supabase.from("events").select("id").eq("is_active", true).maybeSingle();
  if (!activeEvent?.id) return [];

  const { data, error } = await supabase.from("shirt_inventory").select("*, events(name)").eq("event_id", activeEvent.id).order("shirt_type", { ascending: true }).order("shirt_size", { ascending: true });
  if (error) throw error;

  return (data ?? []).map((row: ShirtInventoryRow) => ({
    id: row.id,
    event_name: row.events?.name ?? null,
    shirt_type: row.shirt_type,
    shirt_size: row.shirt_size,
    total_quantity: row.total_quantity,
    reserved_quantity: row.reserved_quantity,
    delivered_quantity: row.delivered_quantity,
    available: row.total_quantity - row.reserved_quantity - row.delivered_quantity,
  }));
}

export default async function ShirtsPage() {
  const rows = await getStock();
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Camisetas" subtitle="Controle de estoque por modelo e tamanho" />
          <SectionCard title="Estoque real" description="Gerencie encomendas e ajustes sem duplicar combinações de modelo e tamanho.">
            <ShirtStockTable rows={rows} />
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
