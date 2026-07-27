import { createServerSupabaseClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { RegistrationWizard } from './wizard';

type CategoryRow = {
  id: string;
  event_id: string;
  name: string;
  slug: string;
  description: string | null;
  capacity: number | null;
  is_active: boolean;
  sort_order: number;
  available_slots: number | null;
};

function eventIsOpen(event: { registration_enabled: boolean; registration_open_at: string | null; registration_close_at: string | null }) {
  if (!event.registration_enabled) return false;
  const now = Date.now();
  const openOk = !event.registration_open_at || new Date(event.registration_open_at).getTime() <= now;
  const closeOk = !event.registration_close_at || new Date(event.registration_close_at).getTime() >= now;
  return openOk && closeOk;
}

export default async function EventRegistrationPage({ params }: { params: Promise<{ eventSlug: string }> }) {
  const { eventSlug } = await params;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/?next=/inscricao/${eventSlug}`);
  }

  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('id, name, slug, description, starts_at, ends_at, location, registration_enabled, registration_open_at, registration_close_at, kit_enabled')
    .eq('slug', eventSlug)
    .maybeSingle();

  if (eventError) throw eventError;

  if (!event?.id) {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
        <div className="mx-auto w-full max-w-3xl rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 text-slate-200">
          Evento não encontrado.
        </div>
      </main>
    );
  }

  const [{ data: categoriesData, error: categoriesError }, { data: benefitsData, error: benefitsError }, { data: kitData, error: kitError }, { data: inventoryData, error: inventoryError }] = await Promise.all([
    supabase.rpc('get_event_ticket_categories', { p_event_id: event.id }),
    supabase.from('ticket_category_benefits').select('id, ticket_category_id, name, description, sort_order').order('sort_order', { ascending: true }),
    supabase.rpc('get_event_kit_items', { p_event_id: event.id }),
    supabase
      .from('shirt_inventory')
      .select('shirt_type, shirt_size, total_quantity, reserved_quantity, delivered_quantity')
      .eq('event_id', event.id),
  ]);

  if (categoriesError) throw categoriesError;
  if (benefitsError) throw benefitsError;
  if (kitError) throw kitError;
  if (inventoryError) throw inventoryError;

  const categories = (categoriesData ?? []).map((row: CategoryRow) => ({
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    description: row.description ? String(row.description) : null,
    capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
    available_slots: row.available_slots === null || row.available_slots === undefined ? null : Number(row.available_slots),
    is_active: Boolean(row.is_active),
    sort_order: Number(row.sort_order ?? 0),
  }));

  const benefitsByCategory: Record<string, Array<{ id: string; name: string; description: string | null }>> = {};
  for (const row of benefitsData ?? []) {
    const categoryId = String(row.ticket_category_id);
    benefitsByCategory[categoryId] ??= [];
    benefitsByCategory[categoryId].push({
      id: String(row.id),
      name: String(row.name),
      description: row.description ? String(row.description) : null,
    });
  }

  const kitItems = (kitData ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    slug: String(row.slug ?? ''),
    description: row.description ? String(row.description) : null,
    item_type: String(row.item_type ?? 'other'),
    quantity_per_participant: Number(row.quantity_per_participant ?? 1),
    requires_variant: Boolean(row.requires_variant),
    is_required: Boolean(row.is_required),
    is_active: Boolean(row.is_active),
    sort_order: Number(row.sort_order ?? 0),
    variants: Array.isArray(row.variants)
      ? row.variants.map((variant: Record<string, unknown>) => ({
          id: String(variant.id ?? ''),
          name: String(variant.name ?? ''),
          value: String(variant.value ?? ''),
          is_active: Boolean(variant.is_active),
        }))
      : [],
  }));

  const inventory = (inventoryData ?? []).map((row) => ({
    shirt_type: String(row.shirt_type),
    shirt_size: String(row.shirt_size),
    available_quantity: Number(row.total_quantity ?? 0) - Number(row.reserved_quantity ?? 0) - Number(row.delivered_quantity ?? 0),
  }));

  const activeKitItems = kitItems.filter((item: { is_active: boolean }) => item.is_active);
  const shirtRequiredItem = activeKitItems.find((item: { item_type: string; is_required: boolean }) => item.item_type === 'shirt' && item.is_required);
  const hasKitStep = activeKitItems.length > 0;

  console.log('[wizard-diagnostic]', {
    eventSlug,
    eventKitEnabled: Boolean(event.kit_enabled),
    loadedKitItems: activeKitItems.map((item: { id: string; item_type: string; is_active: boolean; is_required: boolean; name: string }) => ({
      id: item.id,
      item_type: item.item_type,
      is_active: item.is_active,
      is_required: item.is_required,
      name: item.name,
    })),
    shirtRequiredFound: Boolean(shirtRequiredItem),
    hasKitStep,
    calculatedStepOrder: hasKitStep ? '1-2-3-4-5-6-7' : '1-2-4-5-6-7',
  });

  const isOpen = eventIsOpen({
    registration_enabled: Boolean(event.registration_enabled),
    registration_open_at: event.registration_open_at ? String(event.registration_open_at) : null,
    registration_close_at: event.registration_close_at ? String(event.registration_close_at) : null,
  });

  return (
    <RegistrationWizard
      event={{
        id: String(event.id),
        slug: String(event.slug),
        name: String(event.name),
        description: event.description ? String(event.description) : null,
        starts_at: event.starts_at ? String(event.starts_at) : null,
        ends_at: event.ends_at ? String(event.ends_at) : null,
        location: event.location ? String(event.location) : null,
        registration_enabled: Boolean(event.registration_enabled),
        registration_open_at: event.registration_open_at ? String(event.registration_open_at) : null,
        registration_close_at: event.registration_close_at ? String(event.registration_close_at) : null,
        kit_enabled: Boolean(event.kit_enabled),
      }}
      isOpen={isOpen}
      categories={categories}
      benefitsByCategory={benefitsByCategory}
      kitItems={kitItems}
      inventory={inventory}
    />
  );
}
