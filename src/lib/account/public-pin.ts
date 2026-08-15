import 'server-only';

import { cache } from 'react';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export const getMyPublicPin = cache(async (userId: string | null | undefined) => {
  if (!userId) return null;

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase.rpc('get_my_public_pin');
  const profile = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  const publicPin = String(profile?.public_pin ?? '').trim();

  return publicPin || null;
});
