import type { createServerSupabaseClient } from '@/lib/supabase/server';

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export type AccountScheduleItem = {
  id: string;
  event_id: string;
  event_name: string;
  delivery_at: string;
  title: string;
  location: string | null;
  description: string | null;
  schedule_type: string;
};

export async function getAccountEventSchedule(
  supabase: ServerSupabaseClient,
  eventIds: string[],
  options: { includePast?: boolean; limit?: number } = {},
) {
  if (eventIds.length === 0) return { data: [] as AccountScheduleItem[], error: null };

  let query = supabase
    .from('kit_delivery_schedule')
    .select('id,event_id,delivery_at,title,location,description,schedule_type,events(name)')
    .in('event_id', eventIds)
    .eq('is_active', true)
    .eq('is_visible_to_users', true)
    .order('delivery_at', { ascending: true });

  if (!options.includePast) query = query.gte('delivery_at', new Date().toISOString());
  if (options.limit) query = query.limit(options.limit);

  const { data, error } = await query;
  if (error) return { data: [] as AccountScheduleItem[], error };

  return {
    data: ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
      const event = Array.isArray(row.events) ? row.events[0] : row.events;
      return {
        id: String(row.id),
        event_id: String(row.event_id),
        event_name: String((event as Record<string, unknown> | null)?.name ?? 'Evento'),
        delivery_at: String(row.delivery_at),
        title: String(row.title),
        location: row.location ? String(row.location) : null,
        description: row.description ? String(row.description) : null,
        schedule_type: String(row.schedule_type ?? 'other'),
      };
    }),
    error: null,
  };
}
