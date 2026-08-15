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
  organizationId: string | null;
  bannerHeroUrl: string | null;
  bannerCardUrl: string | null;
};

export type PublicCategory = {
  id: string;
  name: string;
  description: string | null;
  availableSlots: number | null;
  isActive: boolean;
  currentBatchName: string | null;
  currentMalePrice: number | null;
  currentFemalePrice: number | null;
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

export type PublicAttraction = {
  id: string;
  name: string;
  description: string | null;
  bannerUrl: string | null;
};

type EventBySlugRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  registration_enabled: boolean;
  registration_open_at: string | null;
  registration_close_at: string | null;
  shirt_order_deadline: string | null;
  limit_shirt_selection_to_stock: boolean;
  kit_enabled: boolean;
  is_active: boolean;
  year: number | null;
  min_age: number;
  banner_hero_url: string | null;
};

export type EventBySlugResult =
  | { status: 'found'; event: EventBySlugRow; error: null }
  | {
      status: 'not_found';
      event: null;
      error: null;
    }
  | {
      status: 'query_error';
      event: null;
      error: {
        message: string;
        code?: string;
        details?: string;
        hint?: string;
      };
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
    .select('id, name, slug, description, starts_at, ends_at, location, registration_enabled, registration_open_at, registration_close_at, is_active, year, organization_id, banner_hero_url, banner_card_url')
    .eq('is_active', true)
    .is('archived_at', null)
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
    organizationId: event.organization_id ? String(event.organization_id) : null,
    bannerHeroUrl: event.banner_hero_url ? String(event.banner_hero_url) : null,
    bannerCardUrl: event.banner_card_url ? String(event.banner_card_url) : null,
  }));

  return { events, error: null as string | null };
}

export async function getEventBySlug(eventSlug: string): Promise<EventBySlugResult> {
  const supabase = await createServerSupabaseClient();
  const normalizedSlug = String(eventSlug ?? '').trim();

  console.info('[event-by-slug] lookup:start', {
    eventSlug: normalizedSlug,
  });

  const { data: event, error } = await supabase
    .from('events')
    .select('id, name, slug, description, starts_at, ends_at, location, registration_enabled, registration_open_at, registration_close_at, shirt_order_deadline, limit_shirt_selection_to_stock, kit_enabled, is_active, year, min_age, banner_hero_url')
    .eq('slug', normalizedSlug)
    .eq('is_active', true)
    .is('archived_at', null)
    .maybeSingle();

  if (error) {
    console.error('[event-by-slug] lookup:error', {
      eventSlug: normalizedSlug,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });

    return {
      status: 'query_error',
      event: null,
      error: {
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      },
    };
  }

  if (!event?.id) {
    console.info('[event-by-slug] lookup:not-found', {
      eventSlug: normalizedSlug,
    });
    return { status: 'not_found', event: null, error: null };
  }

  console.info('[event-by-slug] lookup:found', {
    eventSlug: normalizedSlug,
    eventId: event.id,
    eventSlugDb: event.slug,
  });

  return {
    status: 'found',
    event: {
      id: String(event.id),
      name: String(event.name ?? 'Evento'),
      slug: String(event.slug ?? normalizedSlug),
      description: event.description ? String(event.description) : null,
      starts_at: event.starts_at ? String(event.starts_at) : null,
      ends_at: event.ends_at ? String(event.ends_at) : null,
      location: event.location ? String(event.location) : null,
      registration_enabled: Boolean(event.registration_enabled),
      registration_open_at: event.registration_open_at ? String(event.registration_open_at) : null,
      registration_close_at: event.registration_close_at ? String(event.registration_close_at) : null,
      shirt_order_deadline: event.shirt_order_deadline ? String(event.shirt_order_deadline) : null,
      limit_shirt_selection_to_stock: Boolean(event.limit_shirt_selection_to_stock),
      kit_enabled: Boolean(event.kit_enabled),
      is_active: Boolean(event.is_active),
      year: event.year === null || event.year === undefined ? null : Number(event.year),
      min_age: Number(event.min_age ?? 18),
      banner_hero_url: event.banner_hero_url ? String(event.banner_hero_url) : null,
    },
    error: null,
  };
}

export async function getPublicEventDetails(eventSlug: string) {
  const eventLookup = await getEventBySlug(eventSlug);

  if (eventLookup.status !== 'found') {
    return {
      status: eventLookup.status,
      event: null,
      categories: [] as PublicCategory[],
      benefitsByCategory: {} as Record<string, PublicBenefit[]>,
      kitItems: [] as PublicKitItem[],
      attractions: [] as PublicAttraction[],
      error: eventLookup.status === 'query_error'
        ? eventLookup.error.message
        : 'Evento nao encontrado.',
      queryError: eventLookup.status === 'query_error' ? eventLookup.error : null,
    };
  }

  const supabase = await createServerSupabaseClient();
  const event = eventLookup.event;

  const [{ data: categoriesData }, { data: benefitsData }, { data: kitData }, { data: attractionsData }] = await Promise.all([
    supabase.rpc('get_event_ticket_categories', { p_event_id: event.id }),
    supabase.from('ticket_category_benefits').select('id, ticket_category_id, name, description').order('sort_order', { ascending: true }),
    supabase.rpc('get_event_kit_items', { p_event_id: event.id }),
    supabase.from('event_attractions').select('id, name, description, banner_url, is_active').eq('event_id', event.id).order('sort_order', { ascending: true }),
  ]);

  const categories = (categoriesData ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id ?? ''),
    name: String(row.name ?? 'Categoria'),
    description: row.description ? String(row.description) : null,
    availableSlots: row.available_slots === null || row.available_slots === undefined ? null : Number(row.available_slots),
    isActive: Boolean(row.is_active),
    currentBatchName: row.current_batch_name ? String(row.current_batch_name) : null,
    currentMalePrice: row.current_male_price === null || row.current_male_price === undefined ? null : Number(row.current_male_price),
    currentFemalePrice: row.current_female_price === null || row.current_female_price === undefined ? null : Number(row.current_female_price),
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

  const attractions = (attractionsData ?? [])
    .filter((row: Record<string, unknown>) => Boolean(row.is_active))
    .map((row: Record<string, unknown>) => ({
      id: String(row.id ?? ''),
      name: String(row.name ?? ''),
      description: row.description ? String(row.description) : null,
      bannerUrl: row.banner_url ? String(row.banner_url) : null,
    }));

  return {
    status: 'found' as const,
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
      bannerHeroUrl: event.banner_hero_url ? String(event.banner_hero_url) : null,
    } as PublicEvent,
    categories,
    benefitsByCategory,
    kitItems,
    attractions,
    error: null as string | null,
    queryError: null,
  };
}
