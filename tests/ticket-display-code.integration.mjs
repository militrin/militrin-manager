import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const localEnvironment = Object.fromEntries(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx.cmd supabase status -o env'], { encoding: 'utf8' })
  .split(/\r?\n/).flatMap((line) => { const match = line.match(/^([A-Z_]+)="?([^"\r\n]+)"?$/); return match ? [[match[1], match[2]]] : []; }));
const apiUrl = String(localEnvironment.API_URL || 'http://127.0.0.1:54321').replace(/\/$/, '');
if (/supabase\.co/i.test(apiUrl)) throw new Error('refusing non-local supabase for display-code integration');
const anonKey = localEnvironment.ANON_KEY;
const serviceKey = localEnvironment.SERVICE_ROLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };

function padCode(displayNumber, itemPosition) {
  return `#${String(displayNumber).padStart(6, '0')}-${String(itemPosition).padStart(2, '0')}`;
}

async function ensureOwnerRole(service) {
  let role = await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle();
  if (!role.data) role = await service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single();
  assert.equal(role.error, null, role.error?.message);
  return role.data.id;
}

async function seedAdminEvent(service, suffix) {
  const email = `display-code-${suffix}@example.test`;
  const password = 'Display-code-local-only-123!';
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null, created.error?.message);
  const userId = created.data.user.id;
  const org = await service.from('organizations').insert({ name: 'Display Code', slug: `display-code-${suffix}`, status: 'active' }).select('id').single();
  assert.equal(org.error, null, org.error?.message);
  const roleId = await ensureOwnerRole(service);
  assert.equal((await service.from('admin_users').insert({ user_id: userId, role_id: roleId, is_active: true })).error, null);
  assert.equal((await service.from('organization_members').insert({ organization_id: org.data.id, user_id: userId, role_id: roleId, is_owner: true, is_active: true })).error, null);
  const event = await service.from('events').insert({
    organization_id: org.data.id, name: 'Evento Codigo Imutavel', year: 2033, slug: `evento-display-code-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2033-10-10T12:00:00Z', min_age: 0,
    allow_holder_change: true, allow_ticket_transfer: true, kit_enabled: true,
  }).select('id').single();
  assert.equal(event.error, null, event.error?.message);
  const category = await service.from('ticket_categories').insert({ event_id: event.data.id, name: 'Geral', slug: `geral-${suffix}`, is_active: true }).select('id').single();
  const batch = await service.from('registration_batches').insert({
    event_id: event.data.id, name: 'Lote 1', sequence_number: 1, male_price: 100, female_price: 90, max_confirmed_registrations: 100, is_active: true,
  }).select('id').single();
  assert.equal(category.error, null, category.error?.message);
  assert.equal(batch.error, null, batch.error?.message);
  await service.from('registration_batch_prices').insert({ batch_id: batch.data.id, ticket_category_id: category.data.id, male_price: 100, female_price: 90 });
  const contact = await service.from('registration_contacts').insert({
    organization_id: org.data.id, full_name: 'Douglas Hobold', email, created_by: userId,
  }).select('id').single();
  assert.equal(contact.error, null, contact.error?.message);
  const admin = createClient(apiUrl, anonKey, options);
  const signIn = await admin.auth.signInWithPassword({ email, password });
  assert.equal(signIn.error, null, signIn.error?.message);
  return {
    service, admin, orgId: org.data.id, eventId: event.data.id, userId,
    categoryId: category.data.id, batchId: batch.data.id, contactId: contact.data.id,
  };
}

async function issueTicket(admin, ctx) {
  const issued = await admin.rpc('issue_manual_ticket_batch', {
    p_registration_contact_id: ctx.contactId,
    p_event_id: ctx.eventId,
    p_ticket_category_id: ctx.categoryId,
    p_batch_id: ctx.batchId,
    p_quantity: 1,
    p_pricing_gender: 'male',
    p_shirt_type: null,
    p_shirt_size: null,
    p_payment_method: 'courtesy',
    p_notes: null,
    p_assign_holder: false,
  });
  assert.equal(issued.error, null, issued.error?.message);
  return issued.data[0].ticket_id;
}

async function loadCode(service, ticketId) {
  const ticket = await service.from('tickets').select('id,order_id,order_item_id,owner_user_id,token').eq('id', ticketId).single();
  assert.equal(ticket.error, null, ticket.error?.message);
  const order = await service.from('orders').select('id,display_number,status').eq('id', ticket.data.order_id).single();
  const item = await service.from('order_items').select('id,item_position,holder_full_name,status').eq('id', ticket.data.order_item_id).single();
  assert.equal(order.error, null, order.error?.message);
  assert.equal(item.error, null, item.error?.message);
  return {
    ticket: ticket.data,
    order: order.data,
    item: item.data,
    code: padCode(order.data.display_number, item.data.item_position),
  };
}

test('display_number definido nao pode mudar; outras colunas do pedido podem', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const ctx = await seedAdminEvent(service, `${Date.now()}-order`);
  const leftover = await service.from('orders').select('id').eq('display_number', 12).maybeSingle();
  if (leftover.data?.id) {
    await service.from('order_items').delete().eq('order_id', leftover.data.id);
    await service.from('orders').delete().eq('id', leftover.data.id);
  }
  const order = await service.from('orders').insert({
    organization_id: ctx.orgId,
    event_id: ctx.eventId,
    order_number: `DISP-${Date.now()}`,
    status: 'confirmed',
    base_amount: 0,
    final_amount: 0,
    buyer_type: 'administrative',
    display_number: 12,
  }).select('id,display_number,status').single();
  assert.equal(order.error, null, order.error?.message);
  assert.equal(order.data.display_number, 12);
  const blocked = await service.from('orders').update({ display_number: 13 }).eq('id', order.data.id).select('id');
  assert.ok(blocked.error, 'UPDATE de display_number deveria falhar');
  assert.match(blocked.error.message, /ORDER_DISPLAY_NUMBER_IMMUTABLE/);
  const other = await service.from('orders').update({ status: order.data.status }).eq('id', order.data.id).select('id,display_number').single();
  assert.equal(other.error, null, other.error?.message);
  assert.equal(other.data.display_number, 12);
});

test('item_position definido nao pode mudar nem virar null; outras colunas do item podem', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const ctx = await seedAdminEvent(service, `${Date.now()}-item`);
  const order = await service.from('orders').insert({
    organization_id: ctx.orgId,
    event_id: ctx.eventId,
    order_number: `POS-${Date.now()}`,
    status: 'confirmed',
    base_amount: 0,
    final_amount: 0,
    buyer_type: 'administrative',
  }).select('id').single();
  assert.equal(order.error, null, order.error?.message);
  const item = await service.from('order_items').insert({
    order_id: order.data.id,
    event_id: ctx.eventId,
    item_kind: 'ticket',
    item_position: 1,
    quantity: 1,
    unit_price: 0,
    final_amount: 0,
    status: 'confirmed',
    ownership_status: 'unassigned',
  }).select('id,item_position').single();
  assert.equal(item.error, null, item.error?.message);
  assert.equal(item.data.item_position, 1);
  const toTwo = await service.from('order_items').update({ item_position: 2 }).eq('id', item.data.id).select('id');
  assert.ok(toTwo.error, 'UPDATE de item_position 1→2 deveria falhar');
  assert.match(toTwo.error.message, /TICKET_ITEM_POSITION_IMMUTABLE/);
  const toNull = await service.from('order_items').update({ item_position: null }).eq('id', item.data.id).select('id');
  assert.ok(toNull.error, 'UPDATE de item_position para null deveria falhar');
  assert.match(toNull.error.message, /TICKET_ITEM_POSITION_IMMUTABLE/);
  const other = await service.from('order_items').update({ holder_full_name: 'Maria' }).eq('id', item.data.id).select('id,item_position,holder_full_name').single();
  assert.equal(other.error, null, other.error?.message);
  assert.equal(other.data.item_position, 1);
  assert.equal(other.data.holder_full_name, 'Maria');
});

test('transferencia, titular, kit e check-in preservam o codigo do ingresso', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const ctx = await seedAdminEvent(service, `${Date.now()}-ops`);
  const ticketId = await issueTicket(ctx.admin, ctx);
  const before = await loadCode(service, ticketId);
  const other = await service.auth.admin.createUser({
    email: `owner-b-${Date.now()}@example.test`, password: 'Owner-b-local-only-123!', email_confirm: true,
  });
  assert.equal(other.error, null, other.error?.message);
  const transferred = await ctx.admin.rpc('admin_transfer_ticket_ownership', {
    p_ticket_id: ticketId,
    p_expected_owner_user_id: before.ticket.owner_user_id,
    p_new_owner_user_id: other.data.user.id,
    p_holder_action: 'keep',
    p_reason_code: 'administrative_adjustment',
    p_reason_text: null,
  });
  assert.equal(transferred.error, null, transferred.error?.message);
  const afterTransfer = await loadCode(service, ticketId);
  assert.equal(afterTransfer.code, before.code);
  assert.equal(afterTransfer.ticket.token, before.ticket.token);
  assert.equal(afterTransfer.ticket.owner_user_id, other.data.user.id);

  const holder = await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: ticketId, p_holder_name: 'João da Silva', p_reason_code: 'third_party_ticket',
  });
  assert.equal(holder.error, null, holder.error?.message);
  const afterHolder = await loadCode(service, ticketId);
  assert.equal(afterHolder.code, before.code);
  assert.equal(afterHolder.item.holder_full_name, 'João da Silva');

  const kit = await ctx.admin.rpc('deliver_ticket_full_kit', { p_ticket_id: ticketId });
  const checkin = await ctx.admin.rpc('checkin_ticket_entry', { p_ticket_id: ticketId });
  assert.equal(kit.error, null, kit.error?.message);
  assert.equal(checkin.error, null, checkin.error?.message);
  const afterOps = await loadCode(service, ticketId);
  assert.equal(afterOps.code, before.code);
  assert.equal(afterOps.ticket.token, before.ticket.token);
});
