import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { EmptyState } from "@/components/mvp/EmptyState";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { BatchesManager } from "./ui";
import Link from "next/link";
import { EventContextSelector } from "@/components/admin/EventContextSelector";

type BatchCategoryRow = {
  id: string;
  event_id: string;
  name: string;
  sequence_number: number;
  ticket_category_id: string;
  category_name: string;
  male_price: number;
  female_price: number;
  max_confirmed_registrations: number | null;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  confirmed_count: number;
  remaining_slots: number | null;
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

async function getBatchesData(eventId: string | null) {
  const supabase = await createServerSupabaseClient();
  const { data: events, error: eventError } = await supabase.from("events").select("id,name,is_active").is("archived_at", null).order("starts_at", { ascending: false });
  const activeEvent = eventId ? (events ?? []).find((event) => event.id === eventId) ?? null : null;

  if (eventError) throw eventError;
  if (!activeEvent?.id) {
    return { activeEvent: null, events: events ?? [], batches: [] as BatchCategoryRow[], categories: [] as CategoryRow[] };
  }

  const [{ data: batchesData, error: batchesError }, { data: categoriesData, error: categoriesError }] = await Promise.all([
    supabase.rpc("get_registration_batches", { p_event_id: activeEvent.id }),
    supabase.rpc("get_event_ticket_categories", { p_event_id: activeEvent.id }),
  ]);

  if (batchesError) throw batchesError;
  if (categoriesError) throw categoriesError;

  return {
    activeEvent, events: events ?? [],
    batches: (batchesData ?? []).map((row: {
      id: string; event_id: string; name: string; sequence_number: number;
      ticket_category_id: string; category_name: string; male_price: number; female_price: number;
      max_confirmed_registrations: number | null; starts_at: string | null; ends_at: string | null; is_active: boolean;
      confirmed_count: number; remaining_slots: number | null; created_at: string; updated_at: string;
    }) => ({
      id: String(row.id),
      event_id: String(row.event_id),
      name: String(row.name),
      sequence_number: Number(row.sequence_number ?? 0),
      ticket_category_id: String(row.ticket_category_id),
      category_name: String(row.category_name),
      male_price: Number(row.male_price ?? 0),
      female_price: Number(row.female_price ?? 0),
      max_confirmed_registrations: row.max_confirmed_registrations === null || row.max_confirmed_registrations === undefined ? null : Number(row.max_confirmed_registrations),
      starts_at: row.starts_at ? String(row.starts_at) : null,
      ends_at: row.ends_at ? String(row.ends_at) : null,
      is_active: Boolean(row.is_active),
      confirmed_count: Number(row.confirmed_count ?? 0),
      remaining_slots: row.remaining_slots === null || row.remaining_slots === undefined ? null : Number(row.remaining_slots),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    })) as BatchCategoryRow[],
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
  };
}

export default async function BatchesPage({ searchParams }: { searchParams: Promise<{ eventId?: string }> }) {
  const params = await searchParams;
  const { activeEvent, events, batches, categories } = await getBatchesData(params.eventId ?? null);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow-strong),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
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
            <EventContextSelector events={events.map((event) => ({ id: String(event.id), name: String(event.name), is_active: Boolean(event.is_active) }))} selectedEventId={activeEvent?.id ? String(activeEvent.id) : null} pathname="/lotes" />
            {!activeEvent?.id ? (
              <EmptyState title="Nenhum evento ativo" description="Ative um evento para configurar lotes." />
            ) : (
              <BatchesManager eventId={activeEvent.id} batches={batches} categories={categories} />
            )}
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
