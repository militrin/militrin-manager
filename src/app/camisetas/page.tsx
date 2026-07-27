import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ShirtStockTable } from "@/components/mvp/ShirtStockTable";

const isDevelopment = process.env.NODE_ENV !== "production";

type ShirtInventoryRow = {
  id: string;
  shirt_type: string;
  shirt_size: string;
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
};

const shirtTypeOrder: Record<string, number> = {
  Camiseta: 1,
  Babylook: 2,
};

const shirtSizeOrder: Record<string, number> = {
  PP: 1,
  P: 2,
  M: 3,
  G: 4,
  GG: 5,
  EG: 6,
  EXG: 7,
  EXGG: 8,
};

type ShirtsPageData = {
  rows: Array<{
    id: string;
    shirt_type: string;
    shirt_size: string;
    total_quantity: number;
    reserved_quantity: number;
    delivered_quantity: number;
    available: number;
  }>;
  errorMessage: string | null;
};

async function getStock() {
  const supabase = await createServerSupabaseClient();

  const { data: activeEvent, error: activeEventError } = await supabase
    .from("events")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();

  if (activeEventError) {
    const detailed = isDevelopment
      ? `Falha ao buscar evento ativo: ${activeEventError.message} (${activeEventError.code ?? "sem-codigo"})`
      : "Não foi possível carregar o evento ativo.";
    return { rows: [], errorMessage: detailed } satisfies ShirtsPageData;
  }

  if (!activeEvent?.id) {
    return { rows: [], errorMessage: "Nenhum evento ativo encontrado." } satisfies ShirtsPageData;
  }

  const { data, error } = await supabase
    .from("shirt_inventory")
    .select("*")
    .eq("event_id", activeEvent.id);

  if (error) {
    const detailed = isDevelopment
      ? `Falha ao consultar shirt_inventory: ${error.message} (${error.code ?? "sem-codigo"})`
      : "Não foi possível carregar o estoque.";
    return { rows: [], errorMessage: detailed } satisfies ShirtsPageData;
  }

  const rows = (data ?? [])
    .map((row: ShirtInventoryRow) => ({
      id: row.id,
      shirt_type: row.shirt_type,
      shirt_size: row.shirt_size,
      total_quantity: row.total_quantity,
      reserved_quantity: row.reserved_quantity,
      delivered_quantity: row.delivered_quantity,
      available: row.total_quantity - row.reserved_quantity - row.delivered_quantity,
    }))
    .sort((a, b) => {
      const typeDiff = (shirtTypeOrder[a.shirt_type] ?? 99) - (shirtTypeOrder[b.shirt_type] ?? 99);
      if (typeDiff !== 0) return typeDiff;
      return (shirtSizeOrder[a.shirt_size] ?? 99) - (shirtSizeOrder[b.shirt_size] ?? 99);
    });

  return { rows, errorMessage: null } satisfies ShirtsPageData;
}

export default async function ShirtsPage() {
  const { rows, errorMessage } = await getStock();
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Camisetas" subtitle="Controle de estoque por modelo e tamanho" />
          <SectionCard title="Estoque real" description="Gerencie encomendas e ajustes sem duplicar combinações de modelo e tamanho.">
            {errorMessage ? (
              <div className="mb-4 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{errorMessage}</div>
            ) : null}
            <ShirtStockTable rows={rows} />
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
