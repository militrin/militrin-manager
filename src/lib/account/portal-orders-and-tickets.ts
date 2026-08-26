import type { createServerSupabaseClient } from '@/lib/supabase/server';
import { resolveCommercialStatus, type CommercialStatus } from '@/lib/dashboard/commercial-status';

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/**
 * Status comercial canonico de uma linha de `orders` vinda de
 * ACCOUNT_ORDERS_SELECT -- reaproveita resolveCommercialStatus (mesma fonte
 * usada pelo Dashboard admin) em vez de cada tela do cliente reimplementar
 * seu proprio "pendente/confirmado/expirado" a partir de order.status cru.
 * Sem isso, um pedido cujo payment ja expirou mas cujo orders.status ainda
 * nao foi varrido (ou so foi expirado do lado do payment por uma rotina
 * legada que nunca toca orders/order_items) aparece "Pendente" pro cliente
 * e "Expirado" pro admin -- exatamente a divergencia que este helper evita.
 */
export function resolveAccountOrderStatus(order: Record<string, unknown>): CommercialStatus {
  const payment = one(order.payments as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
  return resolveCommercialStatus({
    orderStatus: order.status as string | null,
    paymentStatus: (payment as Record<string, unknown> | null)?.payment_status as string | null,
    reservationExpiresAt: (payment as Record<string, unknown> | null)?.expires_at as string | null,
  });
}

// payments.expires_at e a fonte canonica de validade financeira do pagamento
// no fluxo moderno (pedidos multi-item) -- mantida em sincronia com
// order_items.reservation_expires_at por start_order_payment_pix() e zerada
// por expire_stale_order_payments()/_apply_terminal_order_payment_status().
// participants.reservation_expires_at e legado (modelo de 1 participante por
// pedido, orders.participant_id) e fica null em pedidos modernos -- nao e
// mais selecionada aqui pra evitar reintroduzir essa fonte incorreta.
export const ACCOUNT_ORDERS_SELECT =
  'id, order_number, display_number, status, base_amount, discount_amount, final_amount, created_at, confirmed_at, participant_id, event_id, user_id, buyer_type, participants(full_name, ticket_categories(name)), events(id, name, starts_at, location, registration_enabled, registration_open_at, registration_close_at), payments!payments_order_id_fkey(payment_method, payment_status, expires_at), tickets(id, token, status), order_items(id, item_position, status, ownership_status, holder_full_name, participants(full_name), tickets(id, status, token))';

export async function getAccountOrders(supabase: ServerSupabaseClient, userId: string) {
  return supabase
    .from('orders')
    .select(ACCOUNT_ORDERS_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
}

export async function getAccessibleTicketScope(
  supabase: ServerSupabaseClient,
  userId: string,
  purchasedOrders: Array<Record<string, unknown>>,
) {
  const { data: ownerTickets, error: ownerTicketsError } = await supabase
    .from('tickets')
    .select('id,status,token,issued_at,used_at,order_id,order_item_id,event_id,owner_user_id')
    .eq('owner_user_id', userId)
    .neq('status', 'cancelled');

  if (ownerTicketsError) {
    return { orders: [], orderItems: [], tickets: [], ownedEventIds: [], error: ownerTicketsError, stage: 'owner_tickets' as const };
  }

  const purchasedOrderIds = new Set(purchasedOrders.map((order) => String(order.id ?? '')).filter(Boolean));
  // O novo proprietario nao recebe leitura do pedido/financeiro do comprador.
  // Para compor a UI usamos apenas identificadores e evento que ja pertencem ao ticket.
  const transferredOwnerOrderScopes = (ownerTickets ?? []).flatMap((ticket) => {
    const orderId=String(ticket.order_id??'');
    if(!orderId||purchasedOrderIds.has(orderId)) return [];
    return [{id:orderId,event_id:ticket.event_id,user_id:null,buyer_type:'transferred_owner',order_number:null,status:'confirmed',is_ticket_owner_scope:true}];
  });
  const orders: Array<Record<string,unknown>> = [
    ...purchasedOrders,
    ...Array.from(new Map(transferredOwnerOrderScopes.map((order)=>[String(order.id),order])).values()),
  ];
  const orderItemIds = Array.from(new Set((ownerTickets??[]).map((ticket)=>String(ticket.order_item_id??'')).filter(Boolean)));

  const orderItemsResult = orderItemIds.length > 0
    ? await supabase
        .from('order_items')
        .select('id, item_position, status, ownership_status, holder_full_name, shirt_type, shirt_size, participant_id, order_id, ticket_category_id, batch_id')
        .in('id', orderItemIds)
        .order('created_at', { ascending: false })
    : { data: [], error: null };

  if (orderItemsResult.error) {
    return { orders, orderItems: [], tickets: [], ownedEventIds: [], error: orderItemsResult.error, stage: 'order_items' as const };
  }

  const orderItems = (orderItemsResult.data ?? []) as Array<Record<string, unknown>>;

  return {
    orders,
    orderItems,
    tickets: (ownerTickets ?? []) as Array<Record<string, unknown>>,
    ownedEventIds: Array.from(new Set(
      (ownerTickets ?? []).map((ticket) => String(ticket.event_id ?? '')).filter(Boolean),
    )),
    error: null,
    stage: null,
  };
}
