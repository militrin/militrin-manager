import { createServerSupabaseClient } from '@/lib/supabase/server';

export type PublicEvent = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  location: string | null;
  registrationEnabled: boolean;
  registrationOpenAt: string | null;
  registrationCloseAt: string | null;
  isActive: boolean;
  year: number | null;
};

export type PublicCategory = {
  id: string;
  name: string;
  description: string | null;
  availableSlots: number | null;
  isActive: boolean;
};

export type PublicBenefit = {
  id: string;
  ticketCategoryId: string;
  name: string;
  description: string | null;
};

export type PublicKitItem = {
  id: string;
  name: string;
  description: string | null;
  itemType: string;
  quantityPerParticipant: number;
  isRequired: boolean;
  isActive: boolean;
};

export function isEventOpen(event: {
  registrationEnabled: boolean;
  registrationOpenAt: string | null;
  registrationCloseAt: string | null;
}) {
  if (!event.registrationEnabled) return false;
  const now = Date.now();
  const openOk = !event.registrationOpenAt || new Date(event.registrationOpenAt).getTime() <= now;
  const closeOk = !event.registrationCloseAt || new Date(event.registrationCloseAt).getTime() >= now;
  return openOk && closeOk;
}

export async function getPublicEvents() {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from('events')
    .select('id, name, slug, description, starts_at, ends_at, location, registration_enabled, registration_open_at, registration_close_at, is_active, year')
    .order('starts_at', { ascending: true, nullsFirst: false });

  if (error) {
    return { events: [] as PublicEvent[], error: error.message };
  }

  const events = (data ?? []).map((event) => ({
    id: String(event.id),
    name: String(event.name ?? 'Evento'),
    slug: String(event.slug ?? ''),
    description: event.description ? String(event.description) : null,
    startsAt: event.starts_at ? String(event.starts_at) : null,
    endsAt: event.ends_at ? String(event.ends_at) : null,
    location: event.location ? String(event.location) : null,
    registrationEnabled: Boolean(event.registration_enabled),
    registrationOpenAt: event.registration_open_at ? String(event.registration_open_at) : null,
    registrationCloseAt: event.registration_close_at ? String(event.registration_close_at) : null,
    isActive: Boolean(event.is_active),
    year: event.year === null || event.year === undefined ? null : Number(event.year),
  }));

  return { events, error: null as string | null };
}

export async function getPublicEventDetails(eventSlug: string) {
  const supabase = await createServerSupabaseClient();

  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('id, name, slug, description, starts_at, ends_at, location, registration_enabled, registration_open_at, registration_close_at, is_active, year')
    .eq('slug', eventSlug)
    .maybeSingle();

  if (eventError || !event?.id) {
    return {
      event: null,
      categories: [] as PublicCategory[],
      benefitsByCategory: {} as Record<string, PublicBenefit[]>,
      kitItems: [] as PublicKitItem[],
      error: eventError?.message ?? 'Evento nao encontrado.',
    };
  }

  const [{ data: categoriesData }, { data: benefitsData }, { data: kitData }] = await Promise.all([
    supabase.rpc('get_event_ticket_categories', { p_event_id: event.id }),
    supabase.from('ticket_category_benefits').select('id, ticket_category_id, name, description').order('sort_order', { ascending: true }),
    supabase.rpc('get_event_kit_items', { p_event_id: event.id }),
  ]);

  const categories = (categoriesData ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    name: String(row.name ?? 'Categoria'),
    description: row.description ? String(row.description) : null,
    availableSlots: row.available_slots === null || row.available_slots === undefined ? null : Number(row.available_slots),
    isActive: Boolean(row.is_active),
  })).filter((item: PublicCategory) => item.isActive);

  const benefitsByCategory: Record<string, PublicBenefit[]> = {};
  for (const row of benefitsData ?? []) {
    const categoryId = String(row.ticket_category_id ?? '');
    benefitsByCategory[categoryId] ??= [];
    benefitsByCategory[categoryId].push({
      id: String(row.id ?? ''),
      ticketCategoryId: categoryId,
      name: String(row.name ?? ''),
      description: row.description ? String(row.description) : null,
    });
  }

  const kitItems = (kitData ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    name: String(row.name ?? ''),
    description: row.description ? String(row.description) : null,
    itemType: String(row.item_type ?? 'other'),
    quantityPerParticipant: Number(row.quantity_per_participant ?? 1),
    isRequired: Boolean(row.is_required),
    isActive: Boolean(row.is_active),
  })).filter((item: PublicKitItem) => item.isActive);

  return {
    event: {
      id: String(event.id),
      name: String(event.name ?? 'Evento'),
      slug: String(event.slug ?? eventSlug),
      description: event.description ? String(event.description) : null,
      startsAt: event.starts_at ? String(event.starts_at) : null,
      endsAt: event.ends_at ? String(event.ends_at) : null,
      location: event.location ? String(event.location) : null,
      registrationEnabled: Boolean(event.registration_enabled),
      registrationOpenAt: event.registration_open_at ? String(event.registration_open_at) : null,
      registrationCloseAt: event.registration_close_at ? String(event.registration_close_at) : null,
      isActive: Boolean(event.is_active),
      year: event.year === null || event.year === undefined ? null : Number(event.year),
    } as PublicEvent,
    categories,
    benefitsByCategory,
    kitItems,
    error: null as string | null,
  };
}
