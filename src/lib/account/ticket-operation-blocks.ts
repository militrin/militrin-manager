import 'server-only';
import type { createServerSupabaseClient } from '@/lib/supabase/server';

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export async function ticketHasOpenIssueBlock(
  supabase: ServerSupabaseClient,
  ticketId: string,
  column: 'blocks_checkin' | 'blocks_kit_delivery',
) {
  const { data: ticket, error: ticketError } = await supabase.from('tickets')
    .select('participant_id,order_items(participant_id)').eq('id', ticketId).maybeSingle();
  if (ticketError) return { blocked: false, error: ticketError };
  const orderItem = Array.isArray(ticket?.order_items) ? ticket.order_items[0] : ticket?.order_items;
  const participantId = String(ticket?.participant_id ?? orderItem?.participant_id ?? '');
  if (!participantId) return { blocked: false, error: null };
  const { count, error } = await supabase.from('participant_data_issues')
    .select('id', { count: 'exact', head: true }).eq('participant_id', participantId)
    .eq('status', 'open').eq(column, true);
  return { blocked: (count ?? 0) > 0, error };
}
