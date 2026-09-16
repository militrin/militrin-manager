import { cache } from 'react';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * RPC de categorias/lote do evento, deduplicada por eventId no request.
 * Nao ha cache persistente: cada request busca fresco; so evita N+1 no mesmo render.
 */
export const getEventTicketCategories = cache(async (eventId: string) => {
  const supabase = await createServerSupabaseClient();
  return supabase.rpc('get_event_ticket_categories', { p_event_id: eventId });
});
