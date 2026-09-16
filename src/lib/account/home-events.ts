import { cache } from 'react';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export const ACCOUNT_HOME_EVENT_SELECT =
  'id, name, slug, year, starts_at, ends_at, is_active, location, banner_card_url, banner_hero_url';

export type AccountHomeEventRow = {
  id: string;
  name: string | null;
  slug: string | null;
  year: number | null;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean | null;
  location: string | null;
  banner_card_url: string | null;
  banner_hero_url: string | null;
};

function eventIdsKey(ids: string[]) {
  return Array.from(new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean))).sort().join(',');
}

const loadAccountHomeEventsByIds = cache(async (sortedIdsKey: string): Promise<AccountHomeEventRow[]> => {
  const ids = sortedIdsKey.split(',').filter(Boolean);
  if (!ids.length) return [];

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.from('events').select(ACCOUNT_HOME_EVENT_SELECT).in('id', ids);
  return (data ?? []) as AccountHomeEventRow[];
});

export async function getAccountHomeEventsByIds(ids: string[]) {
  return loadAccountHomeEventsByIds(eventIdsKey(ids));
}
