import { notFound } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { EmptyState } from "@/components/mvp/EmptyState";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { EventKitManager } from "@/app/eventos/[id]/ui";

type Params = Promise<{ id: string }>;

export default async function AdminEventDetailsPage({ params }: { params: Params }) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();

  const [{ data: eventData, error: eventError }, { data: kitData, error: kitError }] = await Promise.all([
    supabase.from("events").select("id, name, slug, year, kit_enabled, registration_enabled, is_active").eq("id", id).maybeSingle(),
    supabase.rpc("get_event_kit_items", { p_event_id: id }),
  ]);

  if (eventError) throw eventError;
  if (kitError) throw kitError;
  if (!eventData?.id) notFound();

  const event = {
    id: String(eventData.id),
    name: String(eventData.name),
    slug: String(eventData.slug),
    year: eventData.year === null || eventData.year === undefined ? null : Number(eventData.year),
    kit_enabled: Boolean(eventData.kit_enabled),
    registration_enabled: Boolean(eventData.registration_enabled),
    is_active: Boolean(eventData.is_active),
  };

  const items = (kitData ?? []).map((row: {
    id: string;
    event_id: string;
    name: string;
    slug: string;
    description: string | null;
    item_type: string;
    quantity_per_participant: number;
    requires_variant: boolean;
    is_required: boolean;
    is_active: boolean;
    sort_order: number;
    variants: Array<{
      id: string;
      name: string;
      value: string;
      sort_order: number;
      is_active: boolean;
    }> | null;
  }) => ({
    id: String(row.id),
    event_id: String(row.event_id),
    name: String(row.name),
    slug: String(row.slug),
    description: row.description ? String(row.description) : null,
    item_type: String(row.item_type),
    quantity_per_participant: Number(row.quantity_per_participant ?? 1),
    requires_variant: Boolean(row.requires_variant),
    is_required: Boolean(row.is_required),
    is_active: Boolean(row.is_active),
    sort_order: Number(row.sort_order ?? 0),
    variants: Array.isArray(row.variants)
      ? row.variants.map((variant) => ({
          id: String(variant.id),
          name: String(variant.name),
          value: String(variant.value),
          sort_order: Number(variant.sort_order ?? 0),
          is_active: Boolean(variant.is_active),
        }))
      : [],
  }));

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title={`Evento: ${event.name}`} subtitle="Configuração de kit por item" />
          <SectionCard title="Kit do evento" description="Adicione e configure itens flexíveis do kit.">
            {!event.kit_enabled ? (
              <EmptyState title="Kit desabilitado" description="Ative 'Possui kit' no cadastro do evento para usar itens de kit." />
            ) : (
              <EventKitManager event={event} items={items} />
            )}
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
