import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { EmptyState } from "@/components/mvp/EmptyState";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { EventsManager } from "@/app/eventos/ui";
import { getCurrentPermissionMap, requirePermission } from "@/lib/admin/permissions";

async function getEventsData() {
  const supabase = await createServerSupabaseClient();

  const [{ data: eventsData, error: eventsError }, { data: eventStates, error: eventStatesError }, { data: highlightsData, error: highlightsError }] = await Promise.all([
    supabase.rpc("get_events_overview"),
    supabase.from("events").select("id, name, archived_at, archived_by").order("starts_at", { ascending: false }),
    supabase.from('event_highlights').select('event_id, sort_order, is_active'),
  ]);

  if (eventsError) throw eventsError;
  if (eventStatesError) throw eventStatesError;
  if (highlightsError) throw highlightsError;

  const stateById = new Map((eventStates ?? []).map((row) => [String(row.id), row]));
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
    min_age: number | null;
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
    min_age: Number(row.min_age ?? 18),
    participants_count: Number(row.participants_count ?? 0),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    archived_at: stateById.get(String(row.id))?.archived_at ? String(stateById.get(String(row.id))?.archived_at) : null,
    archived_by: stateById.get(String(row.id))?.archived_by ? String(stateById.get(String(row.id))?.archived_by) : null,
  }));

  return {
    activeEvents: events.filter((event: { is_active: boolean }) => event.is_active).map((event: { id: string; name: string }) => ({ id: event.id, name: event.name })),
    events,
    highlights: (highlightsData ?? []).map((row: { event_id: string; sort_order: number; is_active: boolean }) => ({
      event_id: String(row.event_id),
      sort_order: Number(row.sort_order ?? 0),
      is_active: Boolean(row.is_active),
    })),
  };
}

export default async function AdminEventsPage() {
  await requirePermission("events.view");
  const [{ activeEvents, events, highlights }, permissions] = await Promise.all([
    getEventsData(),
    getCurrentPermissionMap(["events.create", "events.edit", "events.publish", "events.archive"]),
  ]);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Eventos" subtitle="Gestão completa de eventos e configurações de kit" />
          <SectionCard title="Administração de eventos" description="Crie eventos, controle inscrições e configure kits por evento.">
            {events.length === 0 ? (
              <EmptyState title="Nenhum evento cadastrado" description="Crie o primeiro evento para iniciar a gestão." />
            ) : null}
            <EventsManager
              events={events}
              activeEvents={activeEvents}
              highlights={highlights}
              canCreate={Boolean(permissions["events.create"])}
              canEdit={Boolean(permissions["events.edit"])}
              canPublish={Boolean(permissions["events.publish"])}
              canArchive={Boolean(permissions["events.archive"])}
            />
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
