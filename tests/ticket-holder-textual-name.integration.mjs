import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const localEnvironment = Object.fromEntries(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx.cmd supabase status -o env'], { encoding: 'utf8' })
  .split(/\r?\n/).flatMap((line) => { const match = line.match(/^([A-Z_]+)="?([^"\r\n]+)"?$/); return match ? [[match[1], match[2]]] : []; }));
const apiUrl = String(localEnvironment.API_URL || 'http://127.0.0.1:54321').replace(/\/$/, '');
if (/supabase\.co/i.test(apiUrl)) throw new Error('refusing non-local supabase for holder textual integration');
const anonKey = localEnvironment.ANON_KEY;
const serviceKey = localEnvironment.SERVICE_ROLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };

async function ensureOwnerRole(service) {
  let role = await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle();
  if (!role.data) role = await service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single();
  assert.equal(role.error, null, role.error?.message);
  return role.data.id;
}

async function seedAdminEvent(service, suffix) {
  const email = `holder-text-${suffix}@example.test`;
  const password = 'Holder-text-local-only-123!';
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null, created.error?.message);
  const userId = created.data.user.id;
  const org = await service.from('organizations').insert({ name: 'Holder Text', slug: `holder-text-${suffix}`, status: 'active' }).select('id').single();
  assert.equal(org.error, null, org.error?.message);
  const roleId = await ensureOwnerRole(service);
  assert.equal((await service.from('admin_users').insert({ user_id: userId, role_id: roleId, is_active: true })).error, null);
  assert.equal((await service.from('organization_members').insert({ organization_id: org.data.id, user_id: userId, role_id: roleId, is_owner: true, is_active: true })).error, null);
  const event = await service.from('events').insert({
    organization_id: org.data.id, name: 'Evento Titular Textual', year: 2032, slug: `evento-holder-text-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2032-10-10T12:00:00Z', min_age: 0,
    allow_holder_change: true, allow_ticket_transfer: true,
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

async function issueTicket(admin, ctx, assignHolder) {
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
    p_assign_holder: assignHolder,
  });
  assert.equal(issued.error, null, issued.error?.message);
  const ticketId = issued.data[0].ticket_id;
  const owner = await ctx.service.from('tickets').update({ owner_user_id: ctx.userId }).eq('id', ticketId).select('owner_user_id').single();
  assert.equal(owner.error, null, owner.error?.message);
  assert.equal(owner.data.owner_user_id, ctx.userId);
  return ticketId;
}

test('A-C: alterar e remover titular textual preserva owner e nao cria Cadastro', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const ctx = await seedAdminEvent(service, Date.now());
  const ticketId = await issueTicket(ctx.admin, ctx, true);
  const ticketBefore = await service.from('tickets').select('owner_user_id,order_item_id').eq('id', ticketId).single();
  const beforeContacts = await service.from('registration_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', ctx.orgId);
  const beforeParticipants = await service.from('participants').select('id', { count: 'exact', head: true }).eq('event_id', ctx.eventId);

  const asJoao = await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: ticketId, p_holder_name: 'João', p_reason_code: 'third_party_ticket',
  });
  assert.equal(asJoao.error, null, asJoao.error?.message);
  const afterJoao = await service.from('order_items').select('holder_full_name,participant_id,registration_contact_id').eq('id', ticketBefore.data.order_item_id).single();
  const ticketJoao = await service.from('tickets').select('owner_user_id,participant_id').eq('id', ticketId).single();
  assert.equal(afterJoao.data.holder_full_name, 'João');
  assert.equal(afterJoao.data.participant_id, null);
  assert.equal(afterJoao.data.registration_contact_id, null);
  assert.equal(ticketJoao.data.participant_id, null);
  assert.equal(ticketJoao.data.owner_user_id, ticketBefore.data.owner_user_id);

  const asMaria = await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: ticketId, p_holder_name: 'Maria', p_reason_code: 'holder_request',
  });
  assert.equal(asMaria.error, null, asMaria.error?.message);
  const afterMaria = await service.from('order_items').select('holder_full_name').eq('id', ticketBefore.data.order_item_id).single();
  assert.equal(afterMaria.data.holder_full_name, 'Maria');

  const removed = await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: ticketId, p_holder_name: null, p_reason_code: 'administrative_adjustment',
  });
  assert.equal(removed.error, null, removed.error?.message);
  const afterRemove = await service.from('order_items').select('holder_full_name,participant_id,registration_contact_id').eq('id', ticketBefore.data.order_item_id).single();
  const ticketRemoved = await service.from('tickets').select('owner_user_id').eq('id', ticketId).single();
  assert.equal(afterRemove.data.holder_full_name, null);
  assert.equal(afterRemove.data.participant_id, null);
  assert.equal(afterRemove.data.registration_contact_id, null);
  assert.equal(ticketRemoved.data.owner_user_id, ticketBefore.data.owner_user_id);

  const history = await service.from('ticket_holder_history').select('operation,previous_holder_name,new_holder_name').eq('ticket_id', ticketId).order('created_at');
  assert.equal(history.error, null, history.error?.message);
  const names = (history.data ?? []).map((row) => `${row.previous_holder_name ?? ''}→${row.new_holder_name ?? ''}`);
  assert.ok(names.some((row) => row.includes('João→Maria')), `historico esperado João→Maria, obteve ${JSON.stringify(names)}`);
  assert.ok(names.some((row) => row.includes('Maria→')), `historico de remocao ausente: ${JSON.stringify(names)}`);

  const afterContacts = await service.from('registration_contacts').select('id', { count: 'exact', head: true }).eq('organization_id', ctx.orgId);
  const afterParticipants = await service.from('participants').select('id', { count: 'exact', head: true }).eq('event_id', ctx.eventId);
  assert.equal(afterContacts.count, beforeContacts.count);
  assert.equal(afterParticipants.count, beforeParticipants.count);
  const joaoContact = await service.from('registration_contacts').select('id').eq('organization_id', ctx.orgId).eq('full_name', 'João');
  assert.equal((joaoContact.data ?? []).length, 0);
});

test('D: dois ingressos podem ter o mesmo nome textual', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const ctx = await seedAdminEvent(service, `${Date.now()}-dup`);
  const firstId = await issueTicket(ctx.admin, ctx, false);
  const extraContact = await service.from('registration_contacts').insert({
    organization_id: ctx.orgId, full_name: 'Comprador Extra', email: `extra-${Date.now()}@example.test`, created_by: ctx.userId,
  }).select('id').single();
  assert.equal(extraContact.error, null, extraContact.error?.message);
  const secondIssued = await ctx.admin.rpc('issue_manual_ticket_batch', {
    p_registration_contact_id: extraContact.data.id,
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
  assert.equal(secondIssued.error, null, secondIssued.error?.message);
  const secondId = secondIssued.data[0].ticket_id;
  const one = await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: firstId, p_holder_name: 'João', p_reason_code: 'third_party_ticket',
  });
  const two = await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: secondId, p_holder_name: 'João', p_reason_code: 'third_party_ticket',
  });
  assert.equal(one.error, null, one.error?.message);
  assert.equal(two.error, null, two.error?.message);
});

test('F: filtro com titular usa holder_full_name, nao participant_id', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const ctx = await seedAdminEvent(service, `${Date.now()}-filter`);
  const ticketId = await issueTicket(ctx.admin, ctx, false);
  const named = await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: ticketId, p_holder_name: 'João', p_reason_code: 'third_party_ticket',
  });
  assert.equal(named.error, null, named.error?.message);
  const listed = await ctx.admin.rpc('list_admin_tickets', {
    p_organization_id: ctx.orgId, p_event_id: ctx.eventId, p_titularidade: 'com', p_situacao: 'todos',
  });
  assert.equal(listed.error, null, listed.error?.message);
  const row = (listed.data ?? []).find((item) => item.ticket_id === ticketId);
  assert.ok(row, 'ingresso nomeado deve aparecer em com titular');
  assert.equal(row.has_holder, true);
  assert.equal(row.holder_name, 'João');
});

test('Fase 8B SELF mesmo nome preserva FKs e nao gera holder_changed', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const ctx = await seedAdminEvent(service, `${Date.now()}-same`);
  const ticketId = await issueTicket(ctx.admin, ctx, true);
  const before = await service.from('tickets').select('owner_user_id,participant_id,intended_owner_contact_id,order_item_id').eq('id', ticketId).single();
  const itemBefore = await service.from('order_items').select('holder_full_name,participant_id,registration_contact_id').eq('id', before.data.order_item_id).single();
  assert.ok(itemBefore.data.participant_id, 'SELF/materializado precisa de participant');
  assert.ok(itemBefore.data.registration_contact_id, 'SELF/materializado precisa de Cadastro');
  const historyBefore = await service.from('ticket_holder_history').select('id').eq('ticket_id', ticketId);
  const auditsBefore = await service.from('audit_logs').select('id').eq('entity_id', ticketId).eq('action', 'holder_changed');

  const same = await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: ticketId,
    p_holder_name: `  ${itemBefore.data.holder_full_name}  `,
    p_reason_code: 'holder_request',
  });
  assert.equal(same.error, null, same.error?.message);
  assert.equal(same.data.changed, false);

  const itemAfter = await service.from('order_items').select('holder_full_name,participant_id,registration_contact_id').eq('id', before.data.order_item_id).single();
  const ticketAfter = await service.from('tickets').select('owner_user_id,participant_id,intended_owner_contact_id').eq('id', ticketId).single();
  assert.equal(itemAfter.data.holder_full_name, itemBefore.data.holder_full_name);
  assert.equal(itemAfter.data.participant_id, itemBefore.data.participant_id);
  assert.equal(itemAfter.data.registration_contact_id, itemBefore.data.registration_contact_id);
  assert.equal(ticketAfter.data.participant_id, before.data.participant_id);
  assert.equal(ticketAfter.data.owner_user_id, before.data.owner_user_id);
  assert.equal(ticketAfter.data.intended_owner_contact_id, before.data.intended_owner_contact_id);

  const historyAfter = await service.from('ticket_holder_history').select('id').eq('ticket_id', ticketId);
  const auditsAfter = await service.from('audit_logs').select('id').eq('entity_id', ticketId).eq('action', 'holder_changed');
  assert.equal((historyAfter.data ?? []).length, (historyBefore.data ?? []).length);
  assert.equal((auditsAfter.data ?? []).length, (auditsBefore.data ?? []).length);

  const second = await ctx.admin.rpc('issue_manual_ticket_batch', {
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
    p_assign_holder: true,
  });
  assert.ok(second.error, 'unicidade SELF deve continuar a valer apos no-op');
  assert.match(second.error.message, /EXISTING_OPERATIONAL_TICKET|HOLDER_ALREADY_HAS_TICKET_FOR_EVENT/);
});

test('Fase 8B troca real Fabiano→Alessandro zera FKs e preserva owner', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const ctx = await seedAdminEvent(service, `${Date.now()}-swap`);
  const ticketId = await issueTicket(ctx.admin, ctx, true);
  const before = await service.from('tickets').select('owner_user_id,participant_id,intended_owner_contact_id,order_item_id').eq('id', ticketId).single();
  const itemBefore = await service.from('order_items').select('holder_full_name,participant_id,registration_contact_id').eq('id', before.data.order_item_id).single();
  assert.ok(itemBefore.data.participant_id);
  assert.ok(itemBefore.data.registration_contact_id);

  const swapped = await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: ticketId, p_holder_name: 'Alessandro Parizotto', p_reason_code: 'holder_request',
  });
  assert.equal(swapped.error, null, swapped.error?.message);
  assert.equal(swapped.data.changed, true);

  const itemAfter = await service.from('order_items').select('holder_full_name,participant_id,registration_contact_id').eq('id', before.data.order_item_id).single();
  const ticketAfter = await service.from('tickets').select('owner_user_id,participant_id,intended_owner_contact_id').eq('id', ticketId).single();
  assert.equal(itemAfter.data.holder_full_name, 'Alessandro Parizotto');
  assert.equal(itemAfter.data.participant_id, null);
  assert.equal(itemAfter.data.registration_contact_id, null);
  assert.equal(ticketAfter.data.participant_id, null);
  assert.equal(ticketAfter.data.owner_user_id, before.data.owner_user_id);
  assert.equal(ticketAfter.data.intended_owner_contact_id, before.data.intended_owner_contact_id);
  assert.notEqual(ticketAfter.data.owner_user_id, null);

  const history = await service.from('ticket_holder_history').select('operation,previous_holder_name,new_holder_name').eq('ticket_id', ticketId);
  assert.ok((history.data ?? []).some((row) => row.operation === 'holder_changed' && row.new_holder_name === 'Alessandro Parizotto'));
});

test('Fase 8B named mesmo nome permanece textual; nome diferente so atualiza texto', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const ctx = await seedAdminEvent(service, `${Date.now()}-named`);
  const ticketId = await issueTicket(ctx.admin, ctx, false);
  const before = await service.from('tickets').select('owner_user_id,participant_id,intended_owner_contact_id,order_item_id').eq('id', ticketId).single();
  await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: ticketId, p_holder_name: 'João da Silva', p_reason_code: 'third_party_ticket',
  });
  const afterNamed = await service.from('order_items').select('holder_full_name,participant_id,registration_contact_id').eq('id', before.data.order_item_id).single();
  assert.equal(afterNamed.data.holder_full_name, 'João da Silva');
  assert.equal(afterNamed.data.participant_id, null);
  assert.equal(afterNamed.data.registration_contact_id, null);

  const same = await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: ticketId, p_holder_name: 'João da Silva', p_reason_code: 'holder_request',
  });
  assert.equal(same.error, null, same.error?.message);
  assert.equal(same.data.changed, false);
  const stillNamed = await service.from('order_items').select('holder_full_name,participant_id,registration_contact_id').eq('id', before.data.order_item_id).single();
  assert.equal(stillNamed.data.holder_full_name, 'João da Silva');
  assert.equal(stillNamed.data.participant_id, null);
  assert.equal(stillNamed.data.registration_contact_id, null);

  const renamed = await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: ticketId, p_holder_name: 'Maria Souza', p_reason_code: 'holder_request',
  });
  assert.equal(renamed.error, null, renamed.error?.message);
  const afterRename = await service.from('order_items').select('holder_full_name,participant_id,registration_contact_id').eq('id', before.data.order_item_id).single();
  const ticketAfter = await service.from('tickets').select('owner_user_id,participant_id').eq('id', ticketId).single();
  assert.equal(afterRename.data.holder_full_name, 'Maria Souza');
  assert.equal(afterRename.data.participant_id, null);
  assert.equal(afterRename.data.registration_contact_id, null);
  assert.equal(ticketAfter.data.owner_user_id, before.data.owner_user_id);
  assert.equal(ticketAfter.data.participant_id, null);
});

test('Fase 8B unassigned para nome permanece o comportamento atual', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const ctx = await seedAdminEvent(service, `${Date.now()}-unassigned`);
  const ticketId = await issueTicket(ctx.admin, ctx, false);
  const before = await service.from('tickets').select('owner_user_id,participant_id,order_item_id').eq('id', ticketId).single();
  const itemBefore = await service.from('order_items').select('holder_full_name,participant_id,registration_contact_id,ownership_status').eq('id', before.data.order_item_id).single();
  assert.equal(itemBefore.data.holder_full_name, null);

  const assigned = await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: ticketId, p_holder_name: 'Titular Novo', p_reason_code: 'holder_request',
  });
  assert.equal(assigned.error, null, assigned.error?.message);
  assert.equal(assigned.data.changed, true);
  const itemAfter = await service.from('order_items').select('holder_full_name,participant_id,registration_contact_id,ownership_status').eq('id', before.data.order_item_id).single();
  const ticketAfter = await service.from('tickets').select('owner_user_id,participant_id').eq('id', ticketId).single();
  assert.equal(itemAfter.data.holder_full_name, 'Titular Novo');
  assert.equal(itemAfter.data.ownership_status, 'assigned');
  assert.equal(itemAfter.data.participant_id, null);
  assert.equal(itemAfter.data.registration_contact_id, null);
  assert.equal(ticketAfter.data.owner_user_id, before.data.owner_user_id);
  assert.equal(ticketAfter.data.participant_id, null);
});

test('G: criar conta homonima nao altera ingresso nem owner', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const ctx = await seedAdminEvent(service, `${Date.now()}-account`);
  const ticketId = await issueTicket(ctx.admin, ctx, true);
  const before = await service.from('tickets').select('owner_user_id,order_item_id').eq('id', ticketId).single();
  await ctx.admin.rpc('admin_set_ticket_holder_name', {
    p_ticket_id: ticketId, p_holder_name: 'João', p_reason_code: 'third_party_ticket',
  });
  const other = await service.auth.admin.createUser({
    email: `joao-${Date.now()}@example.test`, password: 'Joao-account-local-only-123!', email_confirm: true,
  });
  assert.equal(other.error, null, other.error?.message);
  await service.from('customer_profiles').insert({ user_id: other.data.user.id, full_name: 'João', cpf: '39053344705' });
  const ticket = await service.from('tickets').select('owner_user_id,participant_id').eq('id', ticketId).single();
  const item = await service.from('order_items').select('holder_full_name,registration_contact_id,participant_id').eq('id', before.data.order_item_id).single();
  assert.equal(ticket.data.owner_user_id, before.data.owner_user_id);
  assert.equal(ticket.data.participant_id, null);
  assert.equal(item.data.holder_full_name, 'João');
  assert.equal(item.data.registration_contact_id, null);
});
