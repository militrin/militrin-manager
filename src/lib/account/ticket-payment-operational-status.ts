import type { createServerSupabaseClient } from '@/lib/supabase/server';

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;
type PaymentStatusRow = { ticket_id?: string; payment_status?: string | null };

export type OwnedTicketPaymentStatusLoad = {
  byTicketId: Map<string, string>;
  error: { message: string } | null;
};

// Status operacional do pagamento para chips da Minha Conta. Nunca usa
// `pending` como fallback de leitura: pending so e valido quando a RPC
// autorizada devolve pending de verdade.
export async function loadOwnedTicketsPaymentOperationalStatus(
  supabase: ServerSupabaseClient,
  ticketIds: string[],
): Promise<OwnedTicketPaymentStatusLoad> {
  if (ticketIds.length === 0) return { byTicketId: new Map(), error: null };

  const wanted = new Set(ticketIds);
  const { data, error } = await supabase.rpc('get_my_tickets_payment_operational_status');
  if (error) return { byTicketId: new Map(), error };

  const byTicketId = new Map<string, string>();
  for (const row of (data ?? []) as PaymentStatusRow[]) {
    const ticketId = String(row.ticket_id ?? '');
    if (!ticketId || !wanted.has(ticketId)) continue;
    const status = String(row.payment_status ?? '').trim().toLowerCase();
    if (!status) continue;
    byTicketId.set(ticketId, status);
  }
  return { byTicketId, error: null };
}

export function chipStatusForOwnedTicketPayment(
  ticketId: string,
  load: OwnedTicketPaymentStatusLoad,
): string {
  if (load.error) return 'unavailable';
  const status = load.byTicketId.get(ticketId);
  if (!status) return 'unavailable';
  return status;
}

export function normalizeOwnedTicketPaymentChipStatus(status: string) {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'paid') return 'confirmed';
  return normalized;
}
