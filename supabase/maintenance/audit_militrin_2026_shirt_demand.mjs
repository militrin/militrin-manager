import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries((await readFile(new URL('../../.env.local', import.meta.url), 'utf8'))
  .split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, '')]] : [];
  }));
const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const must = async (query, label) => {
  const result = await query;
  if (result.error) throw new Error(`${label}: ${result.error.code} ${result.error.message}`);
  return result.data ?? [];
};
const sum = (rows) => rows.reduce((total, row) => total + Number(row.quantity ?? 0), 0);

const events = await must(client.from('events').select('id,organization_id,name,slug,year').or('name.ilike.%Militrin 2026%,year.eq.2026'), 'events');
if (events.length !== 1) throw new Error(`Expected one Militrin 2026 event, found ${events.length}: ${events.map((event) => `${event.id}:${event.name}`).join(', ')}`);
const event = events[0];
const [kitItems, physical, tickets, orderItems, orders, payments, kitLinks, storeItems, storeOrders] = await Promise.all([
  must(client.from('event_kit_items').select('id,name,item_type,is_active,shirt_supply_mode').eq('event_id', event.id).eq('item_type', 'shirt'), 'kit items'),
  must(client.from('shirt_inventory').select('id,shirt_type,shirt_size,total_quantity,reserved_quantity,delivered_quantity').eq('event_id', event.id), 'physical inventory'),
  must(client.from('tickets').select('id,order_id,order_item_id,status,used_at').eq('event_id', event.id), 'tickets'),
  must(client.from('order_items').select('id,order_id,item_kind,store_item_id,store_item_variant_id,status,quantity,shirt_type,shirt_size').eq('event_id', event.id), 'order items'),
  must(client.from('orders').select('id,order_number,display_number,status,payment_id').eq('event_id', event.id), 'orders'),
  must(client.from('payments').select('id,order_id,payment_status').eq('event_id', event.id), 'payments'),
  must(client.from('participant_kit_items').select('id,ticket_id,order_item_id,kit_item_id,status,quantity,variant_data,delivered_at').eq('event_id', event.id), 'kit links'),
  must(client.from('store_items').select('id,name,event_id,linked_event_kit_item_id,supply_mode').eq('organization_id', event.organization_id), 'store items'),
  must(client.from('store_orders').select('id,order_number,display_number,status,payment_status,payment_method,event_id').eq('organization_id', event.organization_id), 'store orders'),
]);
const kitItemIds = kitItems.map((row) => row.id);
const linkedStoreItems = storeItems.filter((row) => kitItemIds.includes(row.linked_event_kit_item_id));
const [variants, inventory, storeVariants, storeLines, grantLogs] = await Promise.all([
  must(client.from('event_kit_item_variants').select('id,kit_item_id,name,value,is_active').in('kit_item_id', kitItemIds), 'kit variants'),
  must(client.from('event_kit_item_variant_inventory').select('id,kit_item_id,variant_id,total_quantity,reserved_quantity,delivered_quantity').in('kit_item_id', kitItemIds), 'kit inventory'),
  linkedStoreItems.length ? must(client.from('store_item_variants').select('id,store_item_id,name,value,linked_event_kit_item_variant_id,is_active').in('store_item_id', linkedStoreItems.map((row) => row.id)), 'store variants') : [],
  linkedStoreItems.length ? must(client.from('store_order_items').select('id,store_order_id,store_item_id,variant_id,quantity,status,delivered_at').in('store_item_id', linkedStoreItems.map((row) => row.id)), 'store lines') : [],
  must(client.from('audit_logs').select('entity_id,details,created_at').eq('event_id', event.id).eq('action', 'store_item_admin_granted'), 'grant logs'),
]);
const ticketById = new Map(tickets.map((row) => [row.id, row]));
const orderById = new Map(orders.map((row) => [row.id, row]));
const paymentById = new Map(payments.map((row) => [row.id, row]));
const storeOrderById = new Map(storeOrders.map((row) => [row.id, row]));
const storeVariantById = new Map(storeVariants.map((row) => [row.id, row]));
const grants = new Set(grantLogs.map((row) => row.entity_id));

const report = variants.map((variant) => {
  const inv = inventory.find((row) => row.variant_id === variant.id) ?? {};
  const legacy = physical.find((row) => row.shirt_type?.trim().toLowerCase() === variant.name?.trim().toLowerCase() && row.shirt_size?.trim().toUpperCase() === variant.value?.trim().toUpperCase()) ?? {};
  const ticketRows = kitLinks.filter((row) => row.variant_data?.variant_id === variant.id && ticketById.get(row.ticket_id)?.status === 'active');
  const ticketPending = ticketRows.filter((row) => !['delivered', 'cancelled'].includes(row.status));
  const ticketDelivered = ticketRows.filter((row) => row.status === 'delivered');
  const storeRows = storeLines.filter((row) => storeVariantById.get(row.variant_id)?.linked_event_kit_item_variant_id === variant.id && !['cancelled'].includes(row.status) && !['cancelled', 'expired'].includes(storeOrderById.get(row.store_order_id)?.status));
  const cartRows = orderItems.filter((row) => row.item_kind === 'product' && storeVariantById.get(row.store_item_variant_id)?.linked_event_kit_item_variant_id === variant.id && !['cancelled', 'expired', 'refunded', 'transferred'].includes(row.status) && !['cancelled', 'expired', 'refunded'].includes(orderById.get(row.order_id)?.status));
  const storePending = storeRows.filter((row) => ['reserved', 'confirmed'].includes(row.status));
  const storeDelivered = storeRows.filter((row) => row.status === 'delivered');
  const adminPending = storePending.filter((row) => grants.has(row.id));
  return {
    type: variant.name, size: variant.value, variant_id: variant.id, inventory_id: inv.id,
    total: Number(inv.total_quantity ?? legacy.total_quantity ?? 0), reserved_before: Number(inv.reserved_quantity ?? 0), delivered_before: Number(inv.delivered_quantity ?? 0),
    active_ticket_demand: sum(ticketPending), active_ticket_delivered: sum(ticketDelivered),
    linked_store_demand: sum(storePending) + sum(cartRows.filter((row) => row.status !== 'delivered')), administrative_grants: sum(adminPending), linked_store_delivered: sum(storeDelivered) + sum(cartRows.filter((row) => row.status === 'delivered')),
    reserved_expected: sum(ticketPending) + sum(storePending) + sum(cartRows.filter((row) => row.status !== 'delivered')), delivered_expected: sum(ticketDelivered) + sum(storeDelivered) + sum(cartRows.filter((row) => row.status === 'delivered')),
    ticket_link_ids: ticketPending.map((row) => ({ participant_kit_item_id: row.id, ticket_id: row.ticket_id, order_item_id: row.order_item_id, quantity: row.quantity, status: row.status, order: orderById.get(ticketById.get(row.ticket_id)?.order_id), payment: paymentById.get(orderById.get(ticketById.get(row.ticket_id)?.order_id)?.payment_id) })),
    store_line_ids: storePending.map((row) => ({ ...row, order: storeOrderById.get(row.store_order_id), administrative_grant: grants.has(row.id) })),
    cart_product_line_ids: cartRows.map((row) => ({ ...row, order: orderById.get(row.order_id) })),
  };
});

const targetOrder = [...orders, ...storeOrders].filter((row) => String(row.display_number ?? row.order_number ?? '').replace(/\D/g, '') === '001073' || String(row.display_number ?? row.order_number ?? '').replace(/\D/g, '') === '1073');
console.log(JSON.stringify({ event, linked_store_items: linkedStoreItems, target_order_001073: targetOrder, report }, null, 2));
