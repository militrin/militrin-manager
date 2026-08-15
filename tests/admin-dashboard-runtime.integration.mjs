import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

const apiUrl = 'http://127.0.0.1:54321';
const localEnvironment = Object.fromEntries(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx.cmd supabase status -o env'], { encoding: 'utf8' })
  .split(/\r?\n/).flatMap((line) => { const match = line.match(/^([A-Z_]+)="?([^"\r\n]+)"?$/); return match ? [[match[1], match[2]]] : []; }));
const anonKey = localEnvironment.ANON_KEY;
const serviceKey = localEnvironment.SERVICE_ROLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };

test('consultas do Dashboard renderizam para todos os eventos e para evento selecionado', async (t) => {
  const service = createClient(apiUrl, serviceKey, options);
  const client = createClient(apiUrl, anonKey, options);
  const suffix = Date.now();
  const email = `dashboard-${suffix}@example.test`;
  const created = await service.auth.admin.createUser({ email, password: 'Dashboard-local-123!', email_confirm: true });
  assert.equal(created.error, null, created.error?.message);
  const userId = created.data.user.id;
  const organization = await service.from('organizations').insert({ name: 'Dashboard Runtime', slug: `dashboard-${suffix}`, status: 'active' }).select('id').single();
  assert.equal(organization.error, null, organization.error?.message);
  const organizationId = organization.data.id;
  const events = await service.from('events').insert([1, 2].map((index) => ({ organization_id: organizationId, name: `Dashboard ${index}`, slug: `dashboard-${suffix}-${index}`, year: 2030, starts_at: `2030-0${index}-01T12:00:00Z`, is_active: index === 1 }))).select('id');
  assert.equal(events.error, null, events.error?.message);
  let role = await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle();
  if (!role.data) role = await service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single();
  assert.equal(role.error, null, role.error?.message);
  assert.equal((await service.from('admin_users').insert({ user_id: userId, role_id: role.data.id, is_active: true })).error, null);
  assert.equal((await service.from('organization_members').insert({ organization_id: organizationId, user_id: userId, role_id: role.data.id, is_owner: true, is_active: true })).error, null);
  assert.equal((await client.auth.signInWithPassword({ email, password: 'Dashboard-local-123!' })).error, null);
  const contact = await service.from('registration_contacts').insert({ organization_id: organizationId, full_name: 'Pessoa Pendente' }).select('id').single();
  assert.equal(contact.error, null, contact.error?.message);
  const participant = await service.from('participants').insert({ organization_id: organizationId, event_id: events.data[0].id, registration_contact_id: contact.data.id, full_name: 'Espelho legado', registration_status: 'pending', reservation_status: 'pending' }).select('id').single();
  assert.equal(participant.error, null, participant.error?.message);
  const payment = await service.from('payments').insert({ organization_id: organizationId, event_id: events.data[0].id, participant_id: participant.data.id, amount: 100, discount_amount: 0, final_amount: 100, payment_method: 'pix', payment_status: 'pending' }).select('id').single();
  assert.equal(payment.error, null, payment.error?.message);
  const order = await service.from('orders').insert({ organization_id: organizationId, event_id: events.data[0].id, user_id: userId, participant_id: participant.data.id, payment_id: payment.data.id, order_number: `DASH-${suffix}`, status: 'pending', base_amount: 100, discount_amount: 0, final_amount: 100, buyer_type: 'account' }).select('id').single();
  assert.equal(order.error, null, order.error?.message);
  assert.equal((await service.from('payments').update({ order_id: order.data.id }).eq('id', payment.data.id)).error, null);
  const item = await service.from('order_items').insert({ order_id: order.data.id, event_id: events.data[0].id, participant_id: participant.data.id, registration_contact_id: contact.data.id, ownership_status: 'assigned', holder_full_name: 'Pessoa Pendente', quantity: 1, unit_price: 100, discount_amount: 0, final_amount: 100, status: 'reserved' }).select('id').single();
  assert.equal(item.error, null, item.error?.message);
  assert.equal((await service.from('participant_data_issues').insert({ organization_id: organizationId, event_id: events.data[0].id, participant_id: participant.data.id, field_code: 'cpf', issue_type: 'missing_required_identity', message: 'CPF obrigatório ausente.', blocks_ticket_issuance: true })).error, null);
  t.after(async () => { await service.from('organizations').delete().eq('id', organizationId); await service.auth.admin.deleteUser(userId); });

  const querySet = (eventIds) => ({
    participants: client.from('participants').select('id,event_id,registration_contact_id,full_name,registration_contacts(id,full_name)').in('event_id', eventIds),
    order_items: client.from('order_items').select('id,event_id,status,participant_id,registration_contact_id,ownership_status,holder_full_name,shirt_type,shirt_size,final_amount,created_at,registration_contacts(full_name),participants(full_name,registration_contact_id),ticket_categories(name),registration_batches(name),orders(id,status,payment_id)').in('event_id', eventIds),
    tickets: client.from('tickets').select('id,event_id,status,used_at,issued_at,participant_id,order_item_id,order_id,participants(full_name,registration_contact_id),order_items(holder_full_name,registration_contact_id,shirt_type,shirt_size,ticket_categories(name))').in('event_id', eventIds),
    payments: client.from('payments').select('id,event_id,order_id,participant_id,payment_status,payment_method,final_amount,created_at,paid_at,participants(full_name)').in('event_id', eventIds),
    inventory: client.from('shirt_inventory').select('id,event_id,shirt_type,shirt_size,total_quantity,reserved_quantity,delivered_quantity').in('event_id', eventIds),
    kit_links: client.from('participant_kit_items').select('id,event_id,ticket_id,order_item_id,kit_item_id,status,quantity,variant_data,delivered_at').in('event_id', eventIds),
    kit_definitions: client.from('event_kit_items').select('id,event_id,name,item_type,is_required,is_active,requires_variant').in('event_id', eventIds),
    issues: client.from('participant_data_issues').select('id,event_id,participant_id,field_code,message,status,resolution_scope').eq('status', 'open').in('event_id', eventIds),
    movements: client.from('inventory_movements').select('id,event_id,inventory_id,movement_type,quantity,notes,created_at').in('event_id', eventIds),
  });

  for (const eventIds of [events.data.map((event) => event.id), [events.data[0].id], [events.data[1].id]]) {
    const entries = Object.entries(querySet(eventIds));
    const results = await Promise.all(entries.map(([, query]) => query));
    for (let index = 0; index < results.length; index += 1) {
      assert.equal(results[index].error, null, `${entries[index][0]}: ${results[index].error?.code} ${results[index].error?.message}`);
    }
    if (eventIds.includes(events.data[0].id)) {
      assert.equal(results[entries.findIndex(([name]) => name === 'order_items')].data.some((row) => row.id === item.data.id), true);
      assert.equal(results[entries.findIndex(([name]) => name === 'issues')].data.some((row) => row.participant_id === participant.data.id), true);
    }
  }
});
