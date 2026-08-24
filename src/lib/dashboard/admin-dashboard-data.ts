import 'server-only';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getCurrentOrganizationContext } from '@/lib/organizations/current-organization';

export type DashboardMetricKey =
  | 'people' | 'registrations' | 'confirmed' | 'pending' | 'cancelled'
  | 'tickets' | 'checkins' | 'complete_kits' | 'shirt_coherence'
  | 'shirts_received' | 'shirts_reserved' | 'shirts_delivered' | 'shirts_available' | 'shirts_deficit'
  | 'revenue_confirmed' | 'revenue_pending' | 'pix' | 'card' | 'courtesy';

export type DashboardDetailRow = {
  id: string; primary: string; secondary: string; status: string; value?: number;
  href?: string; actionLabel?: string; issue?: string; requiredPermission?: string;
};

export type DashboardMetric = { key: DashboardMetricKey; label: string; value: number; rows: DashboardDetailRow[] };
// PostgREST devolve relações em formatos dinâmicos (objeto ou array) nesta visão agregada.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const one = (value: unknown) => (Array.isArray(value) ? value[0] : value) as Row | null;
const cancelled = (status: unknown) => ['cancelled', 'canceled', 'void', 'voided', 'refunded', 'expired'].includes(String(status ?? '').toLowerCase());

function personName(item: Row | null | undefined, participant: Row | null | undefined) {
  const canonicalContactName = item?.registration_contacts?.full_name ?? one(item?.registration_contacts)?.full_name;
  const canonicalParticipantName = participant?.registration_contact_id ? participant.full_name : null;
  return String(canonicalContactName ?? canonicalParticipantName ?? 'Titular não definido');
}

export async function loadAdminDashboard(eventId?: string) {
  const supabase = await createServerSupabaseClient();
  const organization = (await getCurrentOrganizationContext()).organization;
  // Nunca 500 por falta de organizacao resolvida -- devolve o mesmo formato
  // "vazio" ja usado quando o evento nao tem dados, pra pagina renderizar o
  // AdminEmptyState existente em vez de a pagina inteira quebrar. Depois de
  // 20260877000000 (organization_members materializado junto com
  // admin_users) isso nao deveria mais acontecer pra ninguem promovido pelo
  // fluxo canonico -- mas nunca deve ser um throw quando acontecer mesmo
  // assim (conta promovida antes da migration, ou organizacao removida).
  if (!organization?.id) {
    return { organization: null, events: [], selectedEvent: null, metrics: new Map<DashboardMetricKey, DashboardMetric>(), hasData: false };
  }
  const { data: events, error: eventsError } = await supabase.from('events').select('id,name,is_active,starts_at,kit_enabled')
    .eq('organization_id', organization.id).order('is_active', { ascending: false }).order('starts_at', { ascending: false, nullsFirst: false });
  if (eventsError) throw eventsError;
  const eventOptions = (events ?? []).map((event) => ({ id: String(event.id), name: String(event.name), is_active: Boolean(event.is_active) }));
  const selectedEvent = eventId && eventId !== 'all' ? eventOptions.find((event) => event.id === eventId) ?? null : null;
  const eventIds = selectedEvent ? [selectedEvent.id] : eventOptions.map((event) => event.id);
  if (!eventIds.length) return { organization, events: eventOptions, selectedEvent, metrics: new Map<DashboardMetricKey, DashboardMetric>(), hasData: false };

  // Os builders do Supabase possuem tipos recursivos profundos; o escopo em si e
  // simples e permanece centralizado para impedir qualquer consulta sem evento.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scope = (query: any) => query.in('event_id', eventIds);
  const [participantsResult, itemsResult, ticketsResult, paymentsResult, inventoryResult, kitsResult, kitDefinitionsResult, issuesResult, movementsResult] = await Promise.all([
    scope(supabase.from('participants').select('id,event_id,registration_contact_id,full_name,registration_contacts(id,full_name)')),
    scope(supabase.from('order_items').select('id,event_id,status,participant_id,registration_contact_id,ownership_status,holder_full_name,shirt_type,shirt_size,final_amount,created_at,registration_contacts(full_name),participants(full_name,registration_contact_id),ticket_categories(name),registration_batches(name),orders(id,status,payment_id)')),
    scope(supabase.from('tickets').select('id,event_id,status,used_at,issued_at,participant_id,order_item_id,order_id,participants(full_name,registration_contact_id),order_items(holder_full_name,registration_contact_id,shirt_type,shirt_size,ticket_categories(name))')),
    scope(supabase.from('payments').select('id,event_id,order_id,participant_id,payment_status,payment_method,final_amount,created_at,paid_at,participants(full_name)')),
    scope(supabase.from('shirt_inventory').select('id,event_id,shirt_type,shirt_size,total_quantity,reserved_quantity,delivered_quantity')),
    scope(supabase.from('participant_kit_items').select('id,event_id,ticket_id,order_item_id,kit_item_id,status,quantity,variant_data,delivered_at')),
    scope(supabase.from('event_kit_items').select('id,event_id,name,item_type,is_required,is_active,requires_variant')),
    // Compatibilidade com o baseline remoto: as pendencias antigas sao ligadas
    // ao participant. A migration contact-first adiciona order_item_id/ticket_id,
    // mas o Dashboard nao pode exigir essas colunas antes de ela ser publicada.
    scope(supabase.from('participant_data_issues').select('id,event_id,participant_id,field_code,message,status,resolution_scope').eq('status', 'open')),
    scope(supabase.from('inventory_movements').select('id,event_id,inventory_id,movement_type,quantity,notes,created_at')),
  ]);
  for (const result of [participantsResult, itemsResult, ticketsResult, paymentsResult, inventoryResult, kitsResult, kitDefinitionsResult, issuesResult, movementsResult]) if (result.error) throw result.error;
  const participants = (participantsResult.data ?? []) as Row[]; const items = (itemsResult.data ?? []) as Row[]; const tickets = (ticketsResult.data ?? []) as Row[];
  const payments = (paymentsResult.data ?? []) as Row[]; const inventory = (inventoryResult.data ?? []) as Row[]; const kits = (kitsResult.data ?? []) as Row[];
  const kitDefinitions = (kitDefinitionsResult.data ?? []) as Row[]; const issues = (issuesResult.data ?? []) as Row[]; const movements = (movementsResult.data ?? []) as Row[];
  const participantById = new Map(participants.map((row) => [String(row.id), row as Row]));
  const itemById = new Map(items.map((row) => [String(row.id), row as Row]));
  const ticketByItem = new Map(tickets.filter((row) => row.order_item_id).map((row) => [String(row.order_item_id), row as Row]));
  const paymentByOrder = new Map(payments.filter((row) => row.order_id).map((row) => [String(row.order_id), row as Row]));
  const issuesByParticipant = new Map<string, Row[]>();
  for (const issue of issues) {
    const key = String(issue.participant_id ?? '');
    if (!key) continue;
    issuesByParticipant.set(key, [...(issuesByParticipant.get(key) ?? []), issue]);
  }

  const itemRow = (item: Row): DashboardDetailRow => {
    const participant = participantById.get(String(item.participant_id ?? '')) ?? one(item.participants);
    const ticket = ticketByItem.get(String(item.id)); const order = one(item.orders); const payment = paymentByOrder.get(String(order?.id ?? ''));
    const open = issuesByParticipant.get(String(item.participant_id ?? '')) ?? [];
    let actionLabel = 'Ver ingresso'; let href = ticket?.id ? `/ingressos/${ticket.id}` : `/inscricoes/${item.participant_id ?? ''}`;
    let requiredPermission: string | undefined;
    if (open.length) {
      // Pendencia do baseline e participant-scoped. Sem order_item_id persistido,
      // nunca escolhemos implicitamente um dos ingressos da pessoa.
      actionLabel = 'Abrir cadastro';
      href = item.registration_contact_id ? `/cadastros/${item.registration_contact_id}` : '/cadastros';
      requiredPermission = 'participants.edit_basic';
    }
    else if (!item.registration_contact_id || item.ownership_status === 'unassigned') { actionLabel = 'Definir titular'; href = ticket?.id ? `/ingressos/${ticket.id}/editar` : '/ingressos'; requiredPermission = 'participants.edit_basic'; }
    else if (!item.shirt_type || !item.shirt_size) { actionLabel = 'Selecionar camiseta'; href = ticket?.id ? `/ingressos/${ticket.id}/editar` : '/camisetas'; requiredPermission = 'inventory.change_participant_shirt'; }
    else if (payment?.payment_status === 'pending') { actionLabel = 'Confirmar pagamento'; href = `/financeiro?tab=sales&status=pending&eventId=${item.event_id}`; requiredPermission = 'finance.confirm_payment'; }
    const textualHolderOnly = !item.registration_contact_id && !participant?.registration_contact_id && String(item.holder_full_name ?? '').trim();
    const snapshotNotice = textualHolderOnly ? `Nome informado na compra: ${String(item.holder_full_name).trim()}` : '';
    const issueMessages = open.map((issue) => String(issue.message ?? issue.field_code));
    if (textualHolderOnly) issueMessages.unshift('Titular informado sem dados suficientes para identificação');
    return { id: String(item.id), primary: personName(item, participant), secondary: [snapshotNotice, one(item.ticket_categories)?.name ?? 'Ingresso único', one(item.registration_batches)?.name ?? 'Sem lote'].filter(Boolean).join(' · '),
      status: String(item.status ?? 'pending'), href, actionLabel, requiredPermission, issue: issueMessages.join(' · ') || undefined };
  };
  const ticketRow = (ticket: Row): DashboardDetailRow => { const item = one(ticket.order_items) ?? itemById.get(String(ticket.order_item_id)); const participant = participantById.get(String(ticket.participant_id ?? '')) ?? one(ticket.participants);
    const textualHolderOnly = !item?.registration_contact_id && !participant?.registration_contact_id && String(item?.holder_full_name ?? '').trim();
    return { id: String(ticket.id), primary: personName(item, participant), secondary: [textualHolderOnly ? `Nome informado na compra: ${String(item?.holder_full_name).trim()}` : '', one(item?.ticket_categories)?.name ?? 'Ingresso único', `#${String(ticket.id).slice(0, 8).toUpperCase()}`].filter(Boolean).join(' · '),
      status: String(ticket.status), href: textualHolderOnly ? `/ingressos/${ticket.id}/editar` : `/ingressos/${ticket.id}`,
      actionLabel: textualHolderOnly ? 'Definir titular' : 'Ver ingresso', requiredPermission: textualHolderOnly ? 'participants.edit_basic' : undefined,
      issue: textualHolderOnly ? 'Titular informado sem dados suficientes para identificação' : undefined }; };
  const checkinRow = (ticket: Row): DashboardDetailRow => ({
    ...ticketRow(ticket), secondary: `${ticketRow(ticket).secondary} · ${ticket.used_at ? new Date(String(ticket.used_at)).toLocaleString('pt-BR') : 'Horário não registrado'}`,
  });
  const shirtAttentionRow = (ticket: Row): DashboardDetailRow => ({
    ...ticketRow(ticket), status: 'shirt_missing', issue: 'Camiseta sem variant_id canônico',
    href: `/ingressos/${ticket.id}/editar`, actionLabel: 'Selecionar camiseta', requiredPermission: 'inventory.change_participant_shirt',
  });
  const paymentRow = (payment: Row): DashboardDetailRow => ({ id: String(payment.id), primary: String(one(payment.participants)?.full_name ?? 'Pagamento'),
    secondary: String(payment.payment_method ?? 'Não informado'), status: String(payment.payment_status), value: Number(payment.final_amount ?? 0),
    href: `/financeiro?tab=sales&status=${payment.payment_method === 'courtesy' ? 'courtesy' : payment.payment_status}&eventId=${payment.event_id}`, actionLabel: 'Ver pagamento' });
  const inventoryRow = (row: Row, status: string, value: number): DashboardDetailRow => {
    const linkedTickets = kits.filter((kit) => String(kit.variant_data?.variant_id ?? '') === String(row.id) && kit.status !== 'cancelled' && kit.ticket_id)
      .map((kit) => `#${String(kit.ticket_id).slice(0, 8).toUpperCase()}`);
    return { id: String(row.id), primary: `${row.shirt_type} ${row.shirt_size}`,
      secondary: `Recebidas ${row.total_quantity} · Reservadas ${row.reserved_quantity} · Entregues ${row.delivered_quantity}`,
      status, value, issue: linkedTickets.length ? `Ingressos: ${linkedTickets.join(', ')}` : undefined,
      href: `/camisetas?eventId=${row.event_id}`, actionLabel: 'Ver estoque' };
  };

  const activeTickets = tickets.filter((ticket) => !cancelled(ticket.status));
  const requiredKitByEvent = new Map<string, string[]>(); const shirtKitByEvent = new Map<string, string[]>();
  for (const definition of kitDefinitions.filter((row) => row.is_active)) { const eventKey = String(definition.event_id); if (definition.is_required) requiredKitByEvent.set(eventKey, [...(requiredKitByEvent.get(eventKey) ?? []), String(definition.id)]); if (definition.item_type === 'shirt') shirtKitByEvent.set(eventKey, [...(shirtKitByEvent.get(eventKey) ?? []), String(definition.id)]); }
  const kitsByTicket = new Map<string, Row[]>(); for (const kit of kits) { const key = String(kit.ticket_id ?? ''); if (!key) continue; kitsByTicket.set(key, [...(kitsByTicket.get(key) ?? []), kit]); }
  const completeTickets = activeTickets.filter((ticket) => { const required = requiredKitByEvent.get(String(ticket.event_id)) ?? []; const linked = kitsByTicket.get(String(ticket.id)) ?? []; return required.length > 0 && required.every((id) => linked.some((kit) => String(kit.kit_item_id) === id && kit.status === 'delivered')); });
  const shirtAttention = activeTickets.filter((ticket) => { const required = shirtKitByEvent.get(String(ticket.event_id)) ?? []; if (!required.length) return false; const linked = kitsByTicket.get(String(ticket.id)) ?? [];
    return !required.some((id) => linked.some((kit) => String(kit.kit_item_id) === id && Boolean(kit.variant_data?.variant_id))); });
  const people = new Map<string, Row>(); for (const participant of participants) if (participant.registration_contact_id) people.set(String(participant.registration_contact_id), participant);
  const peopleRows = [...people.entries()].map(([id, participant]) => ({ id, primary: String(one(participant.registration_contacts)?.full_name ?? 'Pessoa'), secondary: 'Cadastro global vinculado ao evento', status: 'active', href: `/cadastros/${id}`, actionLabel: 'Ver pessoa' }));
  const confirmedItems = items.filter((item) => item.status === 'confirmed'); const pendingItems = items.filter((item) => !cancelled(item.status) && item.status !== 'confirmed'); const cancelledItems = items.filter((item) => cancelled(item.status));
  const paid = payments.filter((payment) => payment.payment_status === 'paid'); const pendingPayments = payments.filter((payment) => payment.payment_status === 'pending');
  const received = inventory.reduce((sum, row) => sum + Number(row.total_quantity ?? 0), 0); const reserved = inventory.reduce((sum, row) => sum + Number(row.reserved_quantity ?? 0), 0);
  const delivered = inventory.reduce((sum, row) => sum + Number(row.delivered_quantity ?? 0), 0); const available = inventory.reduce((sum, row) => sum + Math.max(0, Number(row.total_quantity ?? 0) - Number(row.delivered_quantity ?? 0)), 0);
  const deficit = inventory.reduce((sum, row) => sum + Math.max(0, Number(row.reserved_quantity ?? 0) - Math.max(0, Number(row.total_quantity ?? 0) - Number(row.delivered_quantity ?? 0))), 0);
  const movementRows = movements.filter((movement) => ['purchase', 'adjustment', 'return'].includes(String(movement.movement_type))).map((movement) => ({ id: String(movement.id), primary: String(movement.movement_type), secondary: String(movement.notes ?? 'Movimento de estoque'), status: 'received', value: Number(movement.quantity ?? 0), href: `/camisetas?eventId=${movement.event_id}`, actionLabel: 'Ver estoque' }));
  const metrics = new Map<DashboardMetricKey, DashboardMetric>(); const put = (key: DashboardMetricKey, label: string, value: number, rows: DashboardDetailRow[]) => metrics.set(key, { key, label, value, rows });
  put('people', 'Pessoas no evento', people.size, peopleRows); put('registrations', 'Inscrições comerciais', items.length, items.map(itemRow));
  put('confirmed', 'Inscrições confirmadas', confirmedItems.length, confirmedItems.map(itemRow)); put('pending', 'Inscrições pendentes', pendingItems.length, pendingItems.map(itemRow));
  put('cancelled', 'Inscrições canceladas', cancelledItems.length, cancelledItems.map(itemRow)); put('tickets', 'Ingressos emitidos', tickets.length, tickets.map(ticketRow));
  put('checkins', 'Check-ins realizados', tickets.filter((ticket) => ticket.used_at || ticket.status === 'used').length, tickets.filter((ticket) => ticket.used_at || ticket.status === 'used').map(checkinRow));
  put('complete_kits', 'Kits completos entregues', completeTickets.length, completeTickets.map(ticketRow)); put('shirt_coherence', 'Ingressos com camiseta pendente', shirtAttention.length, shirtAttention.map(shirtAttentionRow));
  put('shirts_received', 'Camisetas recebidas', received, movementRows.length ? movementRows : inventory.map((row) => inventoryRow(row, 'received', Number(row.total_quantity ?? 0))));
  put('shirts_reserved', 'Camisetas reservadas', reserved, inventory.filter((row) => Number(row.reserved_quantity) > 0).map((row) => inventoryRow(row, 'reserved', Number(row.reserved_quantity))));
  put('shirts_delivered', 'Camisetas entregues', delivered, inventory.filter((row) => Number(row.delivered_quantity) > 0).map((row) => inventoryRow(row, 'delivered', Number(row.delivered_quantity))));
  put('shirts_available', 'Disponíveis em estoque', available, inventory.map((row) => inventoryRow(row, 'available', Math.max(0, Number(row.total_quantity) - Number(row.delivered_quantity)))));
  put('shirts_deficit', 'Faltam encomendar', deficit, inventory.filter((row) => Number(row.reserved_quantity) > Number(row.total_quantity) - Number(row.delivered_quantity)).map((row) => inventoryRow(row, 'deficit', Math.max(0, Number(row.reserved_quantity) - (Number(row.total_quantity) - Number(row.delivered_quantity))))));
  put('revenue_confirmed', 'Receita confirmada', paid.reduce((sum, row) => sum + Number(row.final_amount ?? 0), 0), paid.map(paymentRow));
  put('revenue_pending', 'Receita pendente', pendingPayments.reduce((sum, row) => sum + Number(row.final_amount ?? 0), 0), pendingPayments.map(paymentRow));
  put('pix', 'Pagamentos via PIX', paid.filter((row) => row.payment_method === 'pix').length, paid.filter((row) => row.payment_method === 'pix').map(paymentRow));
  put('card', 'Pagamentos via cartão', paid.filter((row) => row.payment_method === 'credit_card').length, paid.filter((row) => row.payment_method === 'credit_card').map(paymentRow));
  put('courtesy', 'Cortesias', paid.filter((row) => row.payment_method === 'courtesy').length, paid.filter((row) => row.payment_method === 'courtesy').map(paymentRow));
  return { organization, events: eventOptions, selectedEvent, metrics, hasData: items.length > 0 || tickets.length > 0 || payments.length > 0 };
}

export function dashboardDetailHref(metric: DashboardMetricKey, eventId?: string | null) {
  const params = new URLSearchParams({ metric }); if (eventId) params.set('eventId', eventId); return `/painel/detalhes?${params.toString()}`;
}
