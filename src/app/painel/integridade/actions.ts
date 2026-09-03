'use server';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { requireAnyPermission, requirePermission } from '@/lib/admin/permissions';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createServiceRoleSupabaseClient } from '@/lib/supabase/admin';
import { mapReportRow } from '@/lib/integrity/report';
import { mapDetectorCheckRow } from '@/lib/integrity/checks';

export type PaidOrderAwaitingIssue = {
  order_id: string;
  order_number: string | null;
  display_number: string | null;
  event_id: string;
  event_name: string;
  buyer_name: string | null;
  holder_summary: string | null;
  paid_at: string | null;
  expected_ticket_items: number;
  missing_ticket_items: number;
  pending_reason: string;
};

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
  const checks = (codesResult.data ?? []).map(mapDetectorCheckRow);
  return { success: true as const, issues, totalDetectorCount: checks.length, checks };
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
  await requireAnyPermission(['integrity.view', 'finance.confirm_payment']);
  const supabase = await createServerSupabaseClient();
  const orgId = await supabase.rpc('current_organization_id');
  if (orgId.error || !orgId.data) return { success: false as const, message: 'Organização não encontrada.', events: [] };
  const { data, error } = await supabase.from('events').select('id,name,starts_at').eq('organization_id', orgId.data).order('starts_at', { ascending: false });
  if (error) return { success: false as const, message: error.message, events: [] };
  return { success: true as const, events: data ?? [] };
}

export async function listPaidOrdersAwaitingTicketIssueAction() {
  await requireAnyPermission(['integrity.view', 'finance.view', 'finance.confirm_payment']);
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('list_paid_orders_awaiting_ticket_issue');
  if (error) return { success: false as const, message: error.message, orders: [] as PaidOrderAwaitingIssue[] };

  const orders: PaidOrderAwaitingIssue[] = (data ?? []).map((row: Record<string, unknown>) => ({
    order_id: String(row.order_id),
    order_number: row.order_number ? String(row.order_number) : null,
    display_number: row.display_number ? String(row.display_number) : null,
    event_id: String(row.event_id),
    event_name: String(row.event_name ?? 'Evento'),
    buyer_name: row.buyer_name ? String(row.buyer_name) : null,
    holder_summary: row.holder_summary ? String(row.holder_summary) : null,
    paid_at: row.paid_at ? String(row.paid_at) : null,
    expected_ticket_items: Number(row.expected_ticket_items ?? 0),
    missing_ticket_items: Number(row.missing_ticket_items ?? 0),
    pending_reason: String(row.pending_reason ?? 'Pedido pago sem ingresso emitido'),
  }));

  return { success: true as const, orders };
}

export type GatewayFinancialDivergence = {
  id: string;
  provider: string;
  provider_payment_id: string | null;
  event_type: string;
  received_at: string;
  last_error: string | null;
};

export async function listGatewayFinancialDivergencesAction() {
  await requireAnyPermission(['integrity.view', 'finance.confirm_payment']);
  // Usa service_role porque a RPC é restrita a service_role (orphan = sem org_id).
  const supabase = createServiceRoleSupabaseClient();
  const { data, error } = await supabase.rpc('list_gateway_financial_divergences');
  if (error) return { success: false as const, message: error.message, divergences: [] as GatewayFinancialDivergence[] };

  const divergences: GatewayFinancialDivergence[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    provider: String(row.provider ?? ''),
    provider_payment_id: row.provider_payment_id ? String(row.provider_payment_id) : null,
    event_type: String(row.event_type ?? ''),
    received_at: String(row.received_at ?? ''),
    last_error: row.last_error ? String(row.last_error) : null,
  }));

  return { success: true as const, divergences };
}

export async function issueTicketsForPaidOrderAction(orderId: string, reason: string) {
  await requirePermission('finance.confirm_payment');
  const parsed = z.object({
    orderId: z.string().uuid(),
    reason: z.string().trim().min(8, 'Informe um motivo com pelo menos 8 caracteres.'),
  }).safeParse({ orderId, reason });
  if (!parsed.success) {
    return { success: false as const, message: parsed.error.issues[0]?.message ?? 'Dados inválidos.' };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('admin_issue_tickets_for_paid_order', {
    p_order_id: parsed.data.orderId,
    p_reason: parsed.data.reason,
  });

  if (error) return { success: false as const, message: error.message };

  const result = data as { success?: boolean; active_ticket_count?: number } | null;
  revalidatePath('/painel/integridade');
  revalidatePath('/financeiro');
  revalidatePath(`/inscricoes/pedido/${parsed.data.orderId}`);
  revalidatePath('/minha-conta/ingressos');
  revalidatePath('/operacoes');

  return {
    success: true as const,
    message: `Ingressos emitidos (${Number(result?.active_ticket_count ?? 0)}).`,
    activeTicketCount: Number(result?.active_ticket_count ?? 0),
  };
}
