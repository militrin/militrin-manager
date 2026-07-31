import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { EmptyState } from "@/components/mvp/EmptyState";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { BatchesManager } from "./ui";
import Link from "next/link";

type BatchRow = {
  id: string;
  event_id: string;
  name: string;
  sequence_number: number;
  male_price: number;
  female_price: number;
  max_confirmed_registrations: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  confirmed_count: number;
  remaining_slots: number;
  created_at: string;
  updated_at: string;
};

type CategoryRow = {
  id: string;
  event_id: string;
  name: string;
  slug: string;
  is_active: boolean;
  sort_order: number;
};

type BatchCategoryPriceRow = {
  batch_id: string;
  ticket_category_id: string;
  male_price: number;
  female_price: number;
};

async function getBatchesData() {
  const supabase = await createServerSupabaseClient();
  const { data: activeEvent, error: eventError } = await supabase
    .from("events")
    .select("id, name")
    .eq("is_active", true)
    .maybeSingle();

  if (eventError) throw eventError;
  if (!activeEvent?.id) {
    return { activeEvent: null, batches: [] as BatchRow[] };
  }

  const { data: batchesData, error: batchesError } = await supabase.rpc("get_registration_batches", {
    p_event_id: activeEvent.id,
  });

  if (batchesError) throw batchesError;

  const [{ data: categoriesData, error: categoriesError }, { data: pricesData, error: pricesError }] = await Promise.all([
    supabase.rpc("get_event_ticket_categories", { p_event_id: activeEvent.id }),
    supabase
      .from("registration_batch_prices")
      .select("batch_id, ticket_category_id, male_price, female_price")
      .in("batch_id", (batchesData ?? []).map((batch: { id: string }) => batch.id)),
  ]);

  if (categoriesError) throw categoriesError;
  if (pricesError) throw pricesError;

  return {
    activeEvent,
    batches: (batchesData ?? []) as BatchRow[],
    categories: (categoriesData ?? []).map((row: {
      id: string;
      event_id: string;
      name: string;
      slug: string;
      is_active: boolean;
      sort_order: number;
    }) => ({
      id: String(row.id),
      event_id: String(row.event_id),
      name: String(row.name),
      slug: String(row.slug),
      is_active: Boolean(row.is_active),
      sort_order: Number(row.sort_order ?? 0),
    })) as CategoryRow[],
    batchCategoryPrices: (pricesData ?? []).map((row: {
      batch_id: string;
      ticket_category_id: string;
      male_price: number;
      female_price: number;
    }) => ({
      batch_id: String(row.batch_id),
      ticket_category_id: String(row.ticket_category_id),
      male_price: Number(row.male_price ?? 0),
      female_price: Number(row.female_price ?? 0),
    })) as BatchCategoryPriceRow[],
  };
}

export default async function BatchesPage() {
  const { activeEvent, batches, categories, batchCategoryPrices } = await getBatchesData();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Lotes" subtitle="Centralizados dentro de Eventos" />
          <SectionCard title="Fluxo atualizado" description="Agora lotes são configurados dentro de cada evento.">
            <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-4 text-sm text-cyan-100">
              <p>Para manter o processo sequencial, configure lotes na tela do evento.</p>
              <Link href="/painel/eventos" className="mt-3 inline-flex rounded-lg border border-cyan-400/40 px-3 py-1.5 text-xs text-cyan-100">
                Ir para Eventos
              </Link>
            </div>
          </SectionCard>
          <SectionCard title="Gestao de lotes" description="Configure limites, precos e o lote ativo do evento.">
            {!activeEvent?.id ? (
              <EmptyState title="Nenhum evento ativo" description="Ative um evento para configurar lotes." />
            ) : (
              <BatchesManager eventId={activeEvent.id} batches={batches} categories={categories} batchCategoryPrices={batchCategoryPrices} />
            )}
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
