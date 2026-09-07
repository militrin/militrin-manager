import type { createServerSupabaseClient } from '@/lib/supabase/server';
import { ADMIN_TICKETS_PAGE_SIZE, type AdminTicketListFilters } from '@/lib/admin/admin-ticket-filters';
import { ticketDisplayReference } from '@/lib/display-reference';
import type { TicketOperationalSituation } from '@/lib/tickets/ticket-situation';

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export type AdminTicketListRow = {
  ticketId: string;
  token: string;
  status: string;
  issuedAt: string | null;
  situacao: TicketOperationalSituation;
  eventId: string;
  eventName: string;
  categoryName: string | null;
  holderName: string;
  hasHolder: boolean;
  hasOwner: boolean;
  orderId: string | null;
  ticketReference: string;
  paymentStatus: string | null;
  checkinDone: boolean;
  kitStatus: 'entregue' | 'pendente' | 'none';
  wristbandCode: string | null;
};

type RpcRow = {
  ticket_id?: string;
  token?: string;
  status?: string;
  issued_at?: string | null;
  used_at?: string | null;
  situacao?: string;
  event_id?: string;
  event_name?: string;
  category_name?: string | null;
  holder_name?: string | null;
  has_holder?: boolean;
  has_owner?: boolean;
  order_id?: string | null;
  order_number?: string | null;
  display_number?: number | null;
  item_position?: number | null;
  payment_status?: string | null;
  checkin_done?: boolean;
  kit_status?: string | null;
  wristband_code?: string | null;
  total_count?: number | string | null;
};

function asSituation(value: string | null | undefined): TicketOperationalSituation {
  if (value === 'anteriores' || value === 'cancelados' || value === 'inativos') return value;
  return 'ativos';
}

export async function listAdminTickets(
  supabase: ServerSupabaseClient,
  organizationId: string,
  filters: AdminTicketListFilters,
) {
  const { data, error } = await supabase.rpc('list_admin_tickets', {
    p_organization_id: organizationId,
    p_event_id: filters.evento || null,
    p_situacao: filters.situacao,
    p_ticket_status: filters.status || null,
    p_category_id: filters.categoria || null,
    p_titularidade: filters.titularidade || null,
    p_conta: filters.conta || null,
    p_checkin: filters.checkin || null,
    p_kit: filters.kit || null,
    p_pagamento: filters.pagamento || null,
    p_search: filters.q || null,
    p_user_id: filters.userId || null,
    p_page: filters.pagina,
    p_page_size: ADMIN_TICKETS_PAGE_SIZE,
  });
  if (error) return { rows: [] as AdminTicketListRow[], total: 0, error };

  const rows = ((data ?? []) as RpcRow[]).map((row) => {
    const kitStatus = row.kit_status === 'entregue' || row.kit_status === 'pendente' ? row.kit_status : 'none';
    return {
      ticketId: String(row.ticket_id ?? ''),
      token: String(row.token ?? ''),
      status: String(row.status ?? ''),
      issuedAt: row.issued_at ? String(row.issued_at) : null,
      situacao: asSituation(row.situacao),
      eventId: String(row.event_id ?? ''),
      eventName: String(row.event_name ?? 'Evento'),
      categoryName: row.category_name ? String(row.category_name) : null,
      holderName: String(row.holder_name ?? 'Sem titular'),
      hasHolder: Boolean(row.has_holder),
      hasOwner: Boolean(row.has_owner),
      orderId: row.order_id ? String(row.order_id) : null,
      ticketReference: ticketDisplayReference(row.display_number, row.item_position, row.order_number),
      paymentStatus: row.payment_status ? String(row.payment_status) : null,
      checkinDone: Boolean(row.checkin_done),
      kitStatus,
      wristbandCode: row.wristband_code ? String(row.wristband_code) : null,
    } satisfies AdminTicketListRow;
  });
  const total = Number(((data ?? []) as RpcRow[])[0]?.total_count ?? rows.length);
  return { rows, total: Number.isFinite(total) ? total : rows.length, error: null };
}
