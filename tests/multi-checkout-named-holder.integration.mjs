import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const apiUrl = 'http://127.0.0.1:54321';
const localEnvironment = Object.fromEntries(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx.cmd supabase status -o env'], { encoding: 'utf8' })
  .split(/\r?\n/).flatMap((line) => { const match = line.match(/^([A-Z_]+)="?([^"\r\n]+)"?$/); return match ? [[match[1], match[2]]] : []; }));
const anonKey = localEnvironment.ANON_KEY;
const serviceKey = localEnvironment.SERVICE_ROLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };

test('checkout multi materializa named contact-first e registra identidade insuficiente', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const anon = createClient(apiUrl, anonKey, options);
  const suffix = Date.now(); const email = `named-${suffix}@example.test`; const password = 'Named-local-only-123!';
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null, created.error?.message); const userId = created.data.user.id;
  const org = await service.from('organizations').insert({ name: 'Named Checkout', slug: `named-${suffix}`, status: 'active' }).select('id').single();
  assert.equal(org.error, null, org.error?.message);
  const event = await service.from('events').insert({ organization_id: org.data.id, name: 'Evento Named', year: 2031,
    slug: `evento-named-${suffix}`, is_active: true, registration_enabled: true, starts_at: '2031-10-10T12:00:00Z', min_age: 0 }).select('id').single();
  assert.equal(event.error, null, event.error?.message);
  const category = await service.from('ticket_categories').insert({ event_id: event.data.id, name: 'Geral', slug: `geral-${suffix}`, is_active: true }).select('id').single();
  const batch = await service.from('registration_batches').insert({ event_id: event.data.id, name: 'Lote 1', sequence_number: 1,
    male_price: 100, female_price: 90, max_confirmed_registrations: 100, is_active: true }).select('id').single();
  assert.equal(category.error, null, category.error?.message); assert.equal(batch.error, null, batch.error?.message);
  const price = await service.from('registration_batch_prices').insert({ batch_id: batch.data.id, ticket_category_id: category.data.id, male_price: 100, female_price: 90 });
  assert.equal(price.error, null, price.error?.message);
  const session = await anon.auth.signInWithPassword({ email, password }); assert.equal(session.error, null, session.error?.message);

  const rpcBase = { p_event_id: event.data.id, p_ticket_category_id: category.data.id, p_gender: 'male', p_payment_method: 'courtesy',
    p_buyer_full_name: 'Comprador Teste', p_buyer_cpf: '52998224725', p_buyer_birth_date: '1990-01-01', p_buyer_gender: 'male',
    p_buyer_phone: '11999990000', p_buyer_email: email, p_buyer_city: 'Sao Paulo', p_limit_per_order: 10 };
  const named = await anon.rpc('create_multi_ticket_order_checkout', { ...rpcBase, p_quantity: 2, p_assign_first_to_buyer: false,
    p_client_request_id: `named-${suffix}`, p_items: [
      { pricing_gender: 'female', ownership_mode: 'named', ownership_status: 'unassigned', holder_full_name: 'Titular Um', holder_cpf: '11144477735' },
      { pricing_gender: 'male', ownership_mode: 'named', ownership_status: 'unassigned', holder_full_name: 'Titular Dois', holder_email: `dois-${suffix}@example.test`, holder_phone: '11988887777' },
    ] });
  assert.equal(named.error, null, named.error?.message); const orderId = named.data[0].order_id;
  const items = await service.from('order_items').select('id,item_position,participant_id,registration_contact_id,ownership_status,holder_full_name').eq('order_id', orderId).order('item_position');
  assert.equal(items.error, null, items.error?.message); assert.equal(items.data.length, 2);
  assert.ok(items.data.every((item) => item.participant_id && item.registration_contact_id && item.ownership_status === 'assigned'));
  assert.notEqual(items.data[0].registration_contact_id, items.data[1].registration_contact_id);
  const tickets = await service.from('tickets').select('id,order_item_id,participant_id,owner_user_id').eq('order_id', orderId);
  assert.equal(tickets.error, null, tickets.error?.message); assert.equal(tickets.data.length, 2);
  assert.ok(tickets.data.every((ticket) => ticket.owner_user_id === userId));
  assert.ok(tickets.data.every((ticket) => ticket.participant_id === items.data.find((item) => item.id === ticket.order_item_id).participant_id));

  const mixed = await anon.rpc('create_multi_ticket_order_checkout', { ...rpcBase, p_quantity: 2, p_assign_first_to_buyer: true,
    p_client_request_id: `mixed-${suffix}`, p_items: [
      { pricing_gender: 'male', ownership_mode: 'self', ownership_status: 'assigned' },
      { pricing_gender: 'female', ownership_mode: 'named', ownership_status: 'unassigned', holder_full_name: 'Titular Tres', holder_cpf: '12345678909' },
    ] });
  assert.equal(mixed.error, null, mixed.error?.message);
  const mixedOrder = await service.from('orders').select('participant_id').eq('id', mixed.data[0].order_id).single();
  const mixedItems = await service.from('order_items').select('participant_id,item_position').eq('order_id', mixed.data[0].order_id).order('item_position');
  const mixedTickets = await service.from('tickets').select('owner_user_id,participant_id').eq('order_id', mixed.data[0].order_id);
  assert.equal(mixedItems.data[0].participant_id, mixedOrder.data.participant_id);
  assert.notEqual(mixedItems.data[1].participant_id, mixedOrder.data.participant_id);
  assert.ok(mixedTickets.data.every((ticket) => ticket.owner_user_id === userId));

  const duplicate = await anon.rpc('create_multi_ticket_order_checkout', { ...rpcBase, p_quantity: 1, p_assign_first_to_buyer: false,
    p_client_request_id: `duplicate-${suffix}`, p_items: [{ pricing_gender: 'female', ownership_mode: 'named', holder_full_name: 'Titular Um', holder_cpf: '11144477735' }] });
  assert.ok(duplicate.error); assert.match(duplicate.error.message, /HOLDER_ALREADY_HAS_TICKET_FOR_EVENT/);

  const insufficient = await anon.rpc('create_multi_ticket_order_checkout', { ...rpcBase, p_quantity: 1, p_assign_first_to_buyer: false,
    p_client_request_id: `insufficient-${suffix}`, p_items: [{ pricing_gender: 'male', ownership_mode: 'named', holder_full_name: 'Somente Nome' }] });
  assert.equal(insufficient.error, null, insufficient.error?.message);
  const pendingItem = await service.from('order_items').select('id,participant_id,registration_contact_id,ownership_status,holder_full_name').eq('order_id', insufficient.data[0].order_id).single();
  assert.equal(pendingItem.data.participant_id, null); assert.equal(pendingItem.data.registration_contact_id, null);
  assert.equal(pendingItem.data.ownership_status, 'unassigned'); assert.equal(pendingItem.data.holder_full_name, 'Somente Nome');
  const issue = await service.from('participant_data_issues').select('message,order_item_id,ticket_id').eq('order_item_id', pendingItem.data.id).eq('status', 'open').single();
  assert.equal(issue.error, null, issue.error?.message); assert.equal(issue.data.message, 'Titular informado sem dados suficientes para identificação'); assert.ok(issue.data.ticket_id);
  await service.auth.admin.deleteUser(userId);
});
