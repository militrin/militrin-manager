import type { createServerSupabaseClient } from '@/lib/supabase/server';

type ServerSupabaseClient = Awaited<ReturnType<typeof createServerSupabaseClient>>;

export const ACCOUNT_ORDERS_SELECT =
  'id, order_number, status, base_amount, discount_amount, final_amount, created_at, confirmed_at, participant_id, event_id, user_id, buyer_type, participants(full_name, reservation_expires_at, ticket_categories(name)), events(id, name, starts_at, location, registration_enabled, registration_open_at, registration_close_at), payments!payments_order_id_fkey(payment_method, payment_status), tickets(id, token, status), order_items(id, item_position, status, ownership_status, holder_full_name, participants(full_name), tickets(id, status, token))';

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
