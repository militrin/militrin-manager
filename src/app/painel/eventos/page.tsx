import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { EmptyState } from "@/components/mvp/EmptyState";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { EventsManager } from "@/app/eventos/ui";

async function getEventsData() {
  const supabase = await createServerSupabaseClient();

  const [{ data: eventsData, error: eventsError }, { data: activeEventData, error: activeEventError }] = await Promise.all([
    supabase.rpc("get_events_overview"),
    supabase.from("events").select("id, name").eq("is_active", true).maybeSingle(),
  ]);

  if (eventsError) throw eventsError;
  if (activeEventError) throw activeEventError;

  const events = (eventsData ?? []).map((row: {
    id: string;
    name: string;
    slug: string;
    year: number | null;
    description: string | null;
    starts_at: string | null;
    ends_at: string | null;
    registration_open_at: string | null;
    registration_close_at: string | null;
    location: string | null;
    registration_enabled: boolean;
    kit_enabled: boolean;
    is_active: boolean;
    participants_count: number;
    created_at: string;
    updated_at: string;
  }) => ({
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    year: row.year === null || row.year === undefined ? null : Number(row.year),
    description: row.description ? String(row.description) : null,
    starts_at: row.starts_at ? String(row.starts_at) : null,
    ends_at: row.ends_at ? String(row.ends_at) : null,
    registration_open_at: row.registration_open_at ? String(row.registration_open_at) : null,
    registration_close_at: row.registration_close_at ? String(row.registration_close_at) : null,
    location: row.location ? String(row.location) : null,
    registration_enabled: Boolean(row.registration_enabled),
    kit_enabled: Boolean(row.kit_enabled),
    is_active: Boolean(row.is_active),
    participants_count: Number(row.participants_count ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));

  return {
    activeEvent: activeEventData?.id ? { id: String(activeEventData.id), name: String(activeEventData.name ?? "") } : null,
    events,
  };
}

export default async function AdminEventsPage() {
  const { activeEvent, events } = await getEventsData();

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Eventos" subtitle="Gestão completa de eventos e configurações de kit" />
          <SectionCard title="Administração de eventos" description="Crie eventos, controle inscrições e configure kits por evento.">
            {events.length === 0 ? (
              <EmptyState title="Nenhum evento cadastrado" description="Crie o primeiro evento para iniciar a gestão." />
            ) : null}
            <EventsManager events={events} activeEvent={activeEvent} />
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
