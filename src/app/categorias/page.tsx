import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { EmptyState } from "@/components/mvp/EmptyState";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { CategoriesManager } from "./ui";
import Link from "next/link";
import { EventContextSelector } from "@/components/admin/EventContextSelector";

async function getCategoriesData(eventId: string | null) {
  const supabase = await createServerSupabaseClient();
  const { data: events, error: eventError } = await supabase.from("events").select("id,name,is_active").is("archived_at", null).order("starts_at", { ascending: false });
  const activeEvent = eventId ? (events ?? []).find((event) => event.id === eventId) ?? null : null;

  if (eventError) throw eventError;
  if (!activeEvent?.id) return { activeEvent: null, events: events ?? [], categories: [], benefits: [] };

  const [{ data: categoriesData, error: categoriesError }, { data: benefitsData, error: benefitsError }] = await Promise.all([
    supabase.rpc("get_event_ticket_categories", { p_event_id: activeEvent.id }),
    supabase
      .from("ticket_category_benefits")
      .select("id, ticket_category_id, name, description, sort_order")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);

  if (categoriesError) throw categoriesError;
  if (benefitsError) throw benefitsError;

  return {
    activeEvent, events: events ?? [],
    categories: (categoriesData ?? []).map((row: {
      id: string;
      event_id: string;
      name: string;
      slug: string;
      description: string | null;
      capacity: number | null;
      is_active: boolean;
      sort_order: number;
      confirmed_count: number;
      pending_count: number;
      reserved_count: number;
      available_slots: number | null;
      current_batch_id: string | null;
    }) => ({
      id: String(row.id),
      event_id: String(row.event_id),
      name: String(row.name),
      slug: String(row.slug),
      description: row.description ? String(row.description) : null,
      capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
      is_active: Boolean(row.is_active),
      sort_order: Number(row.sort_order ?? 0),
      confirmed_count: Number(row.confirmed_count ?? 0),
      pending_count: Number(row.pending_count ?? 0),
      reserved_count: Number(row.reserved_count ?? 0),
      available_slots: row.available_slots === null || row.available_slots === undefined ? null : Number(row.available_slots),
      current_batch_id: row.current_batch_id ? String(row.current_batch_id) : null,
    })),
    benefits: (benefitsData ?? []).map((row: {
      id: string;
      ticket_category_id: string;
      name: string;
      description: string | null;
      sort_order: number;
    }) => ({
      id: String(row.id),
      ticket_category_id: String(row.ticket_category_id),
      name: String(row.name),
      description: row.description ? String(row.description) : null,
      sort_order: Number(row.sort_order ?? 0),
    })),
  };
}

export default async function CategoriesPage({ searchParams }: { searchParams: Promise<{ eventId?: string }> }) {
  const params = await searchParams;
  const { activeEvent, events, categories, benefits } = await getCategoriesData(params.eventId ?? null);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow-strong),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Categorias" subtitle="Centralizadas dentro de Eventos" />
          <SectionCard title="Fluxo atualizado" description="Agora categorias e lotes são configurados dentro de cada evento.">
            <div className="rounded-2xl border border-cyan-500/30 bg-cyan-500/10 p-4 text-sm text-cyan-100">
              <p>Para manter o processo sequencial, configure categorias na tela do evento.</p>
              <Link href="/painel/eventos" className="mt-3 inline-flex rounded-lg border border-cyan-400/40 px-3 py-1.5 text-xs text-cyan-100">
                Ir para Eventos
              </Link>
            </div>
          </SectionCard>
          <SectionCard title="Gestão de categorias" description="Crie, edite, ative/desative e gerencie benefícios por categoria.">
            <EventContextSelector events={events.map((event) => ({ id: String(event.id), name: String(event.name), is_active: Boolean(event.is_active) }))} selectedEventId={activeEvent?.id ? String(activeEvent.id) : null} pathname="/categorias" />
            {!activeEvent?.id ? (
              <EmptyState title="Nenhum evento ativo" description="Ative um evento para configurar categorias de acesso." />
            ) : (
              <CategoriesManager eventId={activeEvent.id} categories={categories} benefits={benefits} />
            )}
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
