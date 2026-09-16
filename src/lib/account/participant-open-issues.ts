import { cache } from 'react';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export type OpenParticipantIssue = {
  id: string;
  participant_id: string | null;
  resolution_scope: string | null;
  field_code: string | null;
  blocks_ticket_issuance: boolean | null;
};

function participantIdsKey(ids: string[]) {
  return Array.from(new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean))).sort().join(',');
}

const loadOpenParticipantIssues = cache(async (sortedIdsKey: string): Promise<OpenParticipantIssue[]> => {
  const ids = sortedIdsKey.split(',').filter(Boolean);
  if (!ids.length) return [];

  const supabase = await createServerSupabaseClient();
  const { data } = await supabase
    .from('participant_data_issues')
    .select('id,resolution_scope,field_code,participant_id,blocks_ticket_issuance')
    .in('participant_id', ids)
    .eq('status', 'open');

  return (data ?? []) as OpenParticipantIssue[];
});

export async function getOpenParticipantIssues(ids: string[]) {
  return loadOpenParticipantIssues(participantIdsKey(ids));
}
