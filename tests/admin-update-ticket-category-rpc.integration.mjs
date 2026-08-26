// Redesign do detalhe do ingresso encontrou um bug real: updateTicketCategoryAction
// fazia um UPDATE direto em order_items via o client vinculado a sessao (RLS),
// mas order_items nao tem NENHUMA policy de UPDATE -- a chamada "sucedia"
// silenciosamente afetando 0 linhas, para QUALQUER usuario (comum ou admin).
// A correcao move a escrita para admin_update_ticket_category (SECURITY
// DEFINER, migration 20260905000000), que agora e a UNICA forma de mudar
// ticket_category_id em order_items, com a permissao checada DENTRO da RPC.
//
// Roda contra o Supabase local (`supabase start` / `supabase db reset`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

function generateValidCpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  function checkDigit(nums) {
    let sum = 0;
    let weight = nums.length + 1;
    for (const n of nums) { sum += n * weight; weight -= 1; }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  }
  const d1 = checkDigit(base);
  const d2 = checkDigit([...base, d1]);
  return [...base, d1, d2].join('');
}

async function environment() {
  const text = await readFile(new URL('../.env.local', import.meta.url), 'utf8').catch(() => '');
  const local = Object.fromEntries(text.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
  }));
  return {
    url: 'http://127.0.0.1:54321',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    serviceKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
    ...local,
  };
}

async function buildFixture() {
  const env = await environment();
  const service = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anonKey = env.anonKey;

  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }
  async function clientFor(email, password) {
    const client = createClient(env.url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`login ${email}: ${signIn.error.message}`);
    return client;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const password = 'SenhaForte!123';
  const org = await must(service.from('organizations').insert({ name: 'Category RPC Test', slug: `cat-rpc-${suffix}` }).select('id').single(), 'org');

  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Category RPC', year: 2026, slug: `cat-rpc-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const categoryA = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'A', slug: `cat-rpc-a-${suffix}`, sort_order: 1, is_active: true, capacity: 10 }).select('id').single(), 'category a');
  const categoryB = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'B', slug: `cat-rpc-b-${suffix}`, sort_order: 2, is_active: true, capacity: 10 }).select('id').single(), 'category b');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: categoryA.id, male_price: 100, female_price: 100 }), 'price a');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: categoryB.id, male_price: 100, female_price: 100 }), 'price b');

  async function makeUser(label, { admin = false } = {}) {
    const email = `cat-rpc-${label}-${suffix}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `create ${label}`);
    await must(service.from('customer_profiles').upsert({ user_id: created.user.id, cpf: generateValidCpf(), full_name: label, birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), `${label} profile`);
    if (admin) {
      const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
      await must(service.from('organization_members').insert({ organization_id: org.id, user_id: created.user.id, is_owner: true, is_active: true }), `${label} org member`);
      await must(service.from('admin_users').insert({ user_id: created.user.id, role_id: ownerRole.id, is_active: true }), `${label} admin_users`);
    }
    return clientFor(email, password);
  }

  async function createOrder(buyer, categoryId, paymentMethod = 'courtesy') {
    const r = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: categoryId, p_gender: 'male', p_quantity: 1,
      p_payment_method: paymentMethod, p_buyer_full_name: 'Buyer Test', p_buyer_cpf: generateValidCpf(),
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: `discard-${Date.now()}@qa.local`, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_items: [{ ownership_mode: 'self' }], p_client_request_id: `cat-rpc-${Date.now()}-${Math.random()}`,
    });
    if (r.error) throw new Error(`create order: ${JSON.stringify(r.error)}`);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return row.order_id;
  }

  async function ticketFor(orderId) {
    const { data } = await service.from('tickets').select('id,order_item_id').eq('order_id', orderId).single();
    return data;
  }

  async function categoryOf(orderItemId) {
    const { data } = await service.from('order_items').select('ticket_category_id').eq('id', orderItemId).single();
    return data.ticket_category_id;
  }

  return { service, org, event, categoryA, categoryB, must, makeUser, createOrder, ticketFor, categoryOf, suffix };
}

const fx = await buildFixture();

test('usuario comum (sem admin_users) nao consegue chamar admin_update_ticket_category diretamente', async () => {
  const buyer = await fx.makeUser('buyer1');
  const orderId = await fx.createOrder(buyer, fx.categoryA.id);
  const ticket = await fx.ticketFor(orderId);

  const result = await buyer.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: fx.categoryB.id });
  assert.ok(result.error, 'usuario comum deve ser recusado pela propria RPC, nao so pelo frontend');

  const categoryAfter = await fx.categoryOf(ticket.order_item_id);
  assert.equal(categoryAfter, fx.categoryA.id, 'categoria nao deve mudar quando a chamada e recusada');
});

test('admin com participants.edit_basic consegue alterar a categoria de verdade (bug do UPDATE direto corrigido)', async () => {
  const buyer = await fx.makeUser('buyer2');
  const admin = await fx.makeUser('admin1', { admin: true });
  const orderId = await fx.createOrder(buyer, fx.categoryA.id);
  const ticket = await fx.ticketFor(orderId);

  const before = await fx.categoryOf(ticket.order_item_id);
  assert.equal(before, fx.categoryA.id);

  const result = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: fx.categoryB.id });
  assert.equal(result.error, null, 'admin com permissao deve conseguir alterar a categoria');

  const after = await fx.categoryOf(ticket.order_item_id);
  assert.equal(after, fx.categoryB.id, 'a categoria deve ter mudado de verdade no banco (nao um sucesso falso)');

  const { data: log } = await fx.service.from('audit_logs').select('id,details').eq('action', 'ticket_category_changed').eq('entity_id', ticket.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  assert.ok(log, 'deve registrar audit log da alteracao');
});

test('admin continua podendo alterar categoria mesmo apos pagamento confirmado (nenhuma regra nova inventada)', async () => {
  const buyer = await fx.makeUser('buyer3');
  const admin = await fx.makeUser('admin2', { admin: true });
  const orderId = await fx.createOrder(buyer, fx.categoryA.id, 'courtesy');
  const { data: order } = await fx.service.from('orders').select('status').eq('id', orderId).single();
  assert.equal(order.status, 'confirmed', 'cortesia confirma o pedido imediatamente');

  const ticket = await fx.ticketFor(orderId);
  const result = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: fx.categoryB.id });
  assert.equal(result.error, null, 'a tarefa nao pediu para bloquear o admin apos confirmacao -- comportamento existente preservado');

  const after = await fx.categoryOf(ticket.order_item_id);
  assert.equal(after, fx.categoryB.id);
});

test('categoria de outro evento e recusada mesmo para admin', async () => {
  const buyer = await fx.makeUser('buyer4');
  const admin = await fx.makeUser('admin3', { admin: true });
  const orderId = await fx.createOrder(buyer, fx.categoryA.id);
  const ticket = await fx.ticketFor(orderId);

  const otherEvent = await fx.must(fx.service.from('events').insert({ organization_id: fx.org.id, name: 'Outro Evento', year: 2026, slug: `cat-rpc-other-${fx.suffix}`, is_active: true, registration_enabled: true, starts_at: '2026-12-01T12:00:00-03:00', min_age: 0 }).select('id').single(), 'other event');
  const otherCategory = await fx.must(fx.service.from('ticket_categories').insert({ event_id: otherEvent.id, name: 'Outra', slug: `cat-rpc-othercat-${fx.suffix}`, sort_order: 1, is_active: true, capacity: 10 }).select('id').single(), 'other category');

  const result = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: otherCategory.id });
  assert.ok(result.error, 'categoria de outro evento nunca deve ser aceita');
  assert.match(result.error.message, /nao pertence ao evento/);
});
