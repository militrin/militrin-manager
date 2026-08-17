'use server';

import { z } from 'zod';
import { requirePermission } from '@/lib/admin/permissions';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { mapReportRow } from '@/lib/integrity/report';

export async function getIntegrityReportAction(eventId: string | null) {
  await requirePermission('integrity.view');
  const parsed = z.string().uuid().nullable().safeParse(eventId);
  if (!parsed.success) return { success: false as const, message: 'Evento inválido.', issues: [] };

  const supabase = await createServerSupabaseClient();
  const [reportResult, codesResult] = await Promise.all([
    supabase.rpc('get_operational_integrity_report', { p_event_id: parsed.data }),
    supabase.rpc('get_operational_integrity_detector_codes'),
  ]);

  if (reportResult.error) return { success: false as const, message: reportResult.error.message, issues: [] };
  if (codesResult.error) return { success: false as const, message: codesResult.error.message, issues: [] };

  const issues = (reportResult.data ?? []).map(mapReportRow);
  return { success: true as const, issues, totalDetectorCount: (codesResult.data ?? []).length as number };
}

export async function getIntegrityIssueEntitiesAction(code: string, eventId: string | null) {
  await requirePermission('integrity.view');
  const parsed = z.object({ code: z.string().trim().min(1), eventId: z.string().uuid().nullable() }).safeParse({ code, eventId });
  if (!parsed.success) return { success: false as const, message: 'Dados inválidos.', entities: [] };

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_operational_integrity_issue_entities', { p_code: parsed.data.code, p_event_id: parsed.data.eventId });
  if (error) return { success: false as const, message: error.message, entities: [] };
  return { success: true as const, entities: data ?? [] };
}

export async function listIntegrityEventsAction() {
  await requirePermission('integrity.view');
  const supabase = await createServerSupabaseClient();
  const orgId = await supabase.rpc('current_organization_id');
  if (orgId.error || !orgId.data) return { success: false as const, message: 'Organização não encontrada.', events: [] };
  const { data, error } = await supabase.from('events').select('id,name,starts_at').eq('organization_id', orgId.data).order('starts_at', { ascending: false });
  if (error) return { success: false as const, message: error.message, events: [] };
  return { success: true as const, events: data ?? [] };
}
