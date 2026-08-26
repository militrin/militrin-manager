// Redesign do detalhe do ingresso encontrou um bug real: updateTicketCategoryAction
// fazia um UPDATE direto em order_items via o client vinculado a sessao (RLS),
// mas order_items nao tem NENHUMA policy de UPDATE -- a chamada "sucedia"
// silenciosamente afetando 0 linhas, para QUALQUER usuario (comum ou admin).
// A correcao move a escrita para admin_update_ticket_category (SECURITY
// DEFINER, migration 20260905000000), que agora e a UNICA forma de mudar
// ticket_category_id em order_items, com a permissao checada DENTRO da RPC.
//
// REVISAO (20260906000000): a RPC ganhou bloqueio pos-pagamento/check-in com
// override administrativo explicito (p_confirm_after_payment +
// p_override_reason obrigatorio), usando a mesma semantica canonica de
// "pago" do Dashboard (resolveCommercialStatus): orders.status OU
// order_items.status = 'confirmed' OU payments.payment_status = 'paid'.
// Os testes de divergencia abaixo simulam estados que o fluxo normal de
// checkout nao produz sozinho (ex.: payments.payment_status='paid' com
// orders.status revertido pra 'pending' via service role) -- isso modela
// exatamente o cenario documentado em apply_gateway_payment_status
// (payment_paid_after_expired/cancelled com needs_manual_reconciliation) e
// qualquer outra divergencia futura entre as duas fontes, sem depender de
// reproduzir o webhook real.
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

  // Cria um pedido confirmado+pago (cortesia sempre confirma na hora e ja
  // emite ticket) e devolve tudo que os testes de divergencia precisam pra
  // depois reverter campos individuais via service role.
  async function createConfirmedOrderWithTicket(buyer, categoryId) {
    const orderId = await createOrder(buyer, categoryId, 'courtesy');
    const order = await must(service.from('orders').select('id,status,payment_id').eq('id', orderId).single(), 'order');
    const ticket = await ticketFor(orderId);
    const orderItem = await must(service.from('order_items').select('id,status').eq('id', ticket.order_item_id).single(), 'order_item');
    return { orderId, order, ticket, orderItem };
  }

  return { service, org, event, categoryA, categoryB, must, makeUser, createOrder, createConfirmedOrderWithTicket, ticketFor, categoryOf, suffix };
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

test('admin com participants.edit_basic altera categoria de um ingresso ainda nao pago (fluxo atual preservado)', async () => {
  const buyer = await fx.makeUser('buyer2');
  const admin = await fx.makeUser('admin1', { admin: true });
  const { orderId, ticket, order, orderItem } = await fx.createConfirmedOrderWithTicket(buyer, fx.categoryA.id);

  // Simula um ingresso ja emitido mas ainda NAO pago (nenhum dos 3 sinais
  // canonicos indica confirmado) -- cortesia confirma e paga na hora, entao
  // revertemos os 3 sinais explicitamente pra testar o caminho "pendente"
  // isolado.
  await fx.must(fx.service.from('orders').update({ status: 'pending' }).eq('id', orderId), 'revert order pending');
  await fx.must(fx.service.from('order_items').update({ status: 'reserved' }).eq('id', orderItem.id), 'revert item reserved');
  await fx.must(fx.service.from('payments').update({ payment_status: 'pending' }).eq('id', order.payment_id), 'revert payment pending');

  const result = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: fx.categoryB.id });
  assert.equal(result.error, null, 'pedido pendente nao deve exigir override');

  const after = await fx.categoryOf(ticket.order_item_id);
  assert.equal(after, fx.categoryB.id, 'a categoria deve ter mudado de verdade no banco');

  const { data: log } = await fx.service.from('audit_logs').select('id,action,details').eq('action', 'ticket_category_changed').eq('entity_id', ticket.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  assert.ok(log, 'deve registrar audit log da alteracao sem override');
  assert.equal(log.details.was_paid, false);
  assert.equal(log.details.was_checked_in, false);
});

test('pedido confirmado (orders.status) bloqueia sem override e libera com motivo', async () => {
  const buyer = await fx.makeUser('buyer3');
  const admin = await fx.makeUser('admin2', { admin: true });
  const { orderId, ticket } = await fx.createConfirmedOrderWithTicket(buyer, fx.categoryA.id);
  const { data: order } = await fx.service.from('orders').select('status').eq('id', orderId).single();
  assert.equal(order.status, 'confirmed', 'cortesia confirma o pedido imediatamente');

  const blocked = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: fx.categoryB.id });
  assert.ok(blocked.error, 'pedido confirmado deve exigir confirmacao explicita');
  assert.match(blocked.error.message, /pagamento deste pedido ja esta confirmado/i);

  const noReason = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: fx.categoryB.id, p_confirm_after_payment: true });
  assert.ok(noReason.error, 'override sem motivo deve ser rejeitado');
  assert.match(noReason.error.message, /motivo/i);

  const overridden = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: fx.categoryB.id, p_confirm_after_payment: true, p_override_reason: 'Correcao combinada com o comprador via suporte.' });
  assert.equal(overridden.error, null, 'override com motivo deve ser aceito');

  const after = await fx.categoryOf(ticket.order_item_id);
  assert.equal(after, fx.categoryB.id);

  const { data: log } = await fx.service.from('audit_logs').select('id,action,details').eq('action', 'ticket_category_changed_after_payment').eq('entity_id', ticket.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  assert.ok(log, 'deve registrar audit log com a acao especifica de override pos-pagamento');
  assert.equal(log.details.was_paid, true);
  assert.equal(log.details.was_checked_in, false);
  assert.equal(log.details.override_reason, 'Correcao combinada com o comprador via suporte.');
});

test('payments.payment_status=paid bloqueia mesmo com orders.status divergente (nao confia so em orders.status)', async () => {
  const buyer = await fx.makeUser('buyer5');
  const admin = await fx.makeUser('admin4', { admin: true });
  const { orderId, ticket, order, orderItem } = await fx.createConfirmedOrderWithTicket(buyer, fx.categoryA.id);

  // orders.status/order_items.status revertidos pra um valor pre-confirmacao,
  // mas payments.payment_status continua 'paid' -- reproduz exatamente a
  // divergencia documentada em resolveCommercialStatus/apply_gateway_payment_status
  // (orders.status pode ficar preso, payments.payment_status e o sinal mais
  // confiavel).
  await fx.must(fx.service.from('orders').update({ status: 'expired' }).eq('id', orderId), 'diverge order status');
  await fx.must(fx.service.from('order_items').update({ status: 'reserved' }).eq('id', orderItem.id), 'diverge item status');
  const { data: payment } = await fx.service.from('payments').select('id,payment_status').eq('id', order.payment_id).single();
  assert.equal(payment.payment_status, 'paid', 'cortesia ja deixa o pagamento como paid');

  const blocked = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: fx.categoryB.id });
  assert.ok(blocked.error, 'payment_status=paid sozinho ja deve bloquear, mesmo com orders.status divergente');

  const overridden = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: fx.categoryB.id, p_confirm_after_payment: true, p_override_reason: 'Divergencia confirmada com o financeiro.' });
  assert.equal(overridden.error, null);
  const after = await fx.categoryOf(ticket.order_item_id);
  assert.equal(after, fx.categoryB.id);
});

test('order_items.status=confirmed sozinho (sem orders.status/payment confirmados) tambem bloqueia', async () => {
  const buyer = await fx.makeUser('buyer6');
  const admin = await fx.makeUser('admin5', { admin: true });
  const { orderId, ticket, order, orderItem } = await fx.createConfirmedOrderWithTicket(buyer, fx.categoryA.id);

  await fx.must(fx.service.from('orders').update({ status: 'pending' }).eq('id', orderId), 'revert order pending');
  await fx.must(fx.service.from('payments').update({ payment_status: 'pending' }).eq('id', order.payment_id), 'revert payment pending');
  const { data: item } = await fx.service.from('order_items').select('status').eq('id', orderItem.id).single();
  assert.equal(item.status, 'confirmed', 'cortesia ja deixa o order_item como confirmed');

  const blocked = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: fx.categoryB.id });
  assert.ok(blocked.error, 'order_items.status=confirmed sozinho ja deve bloquear');
});

test('ticket com check-in realizado bloqueia e override registra causa distinta na auditoria', async () => {
  const buyer = await fx.makeUser('buyer7');
  const admin = await fx.makeUser('admin6', { admin: true });
  const { ticket } = await fx.createConfirmedOrderWithTicket(buyer, fx.categoryA.id);

  await fx.must(fx.service.from('tickets').update({ status: 'used', used_at: new Date().toISOString() }).eq('id', ticket.id), 'mark checked in');

  const blocked = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: fx.categoryB.id });
  assert.ok(blocked.error, 'ticket com check-in deve bloquear mesmo com override nao enviado');
  assert.match(blocked.error.message, /check-in/i);

  const overridden = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: fx.categoryB.id, p_confirm_after_payment: true, p_override_reason: 'Ajuste solicitado apos o evento.' });
  assert.equal(overridden.error, null);

  const { data: log } = await fx.service.from('audit_logs').select('id,action,details').eq('action', 'ticket_category_changed_after_checkin').eq('entity_id', ticket.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  assert.ok(log, 'acao de auditoria deve distinguir check-in de pagamento simples');
  assert.equal(log.details.was_checked_in, true);
  assert.equal(log.details.was_paid, true, 'was_paid continua registrado mesmo quando o nome da acao prioriza o check-in');
});

test('categoria de outro evento e recusada mesmo para admin (mesmo com override valido)', async () => {
  const buyer = await fx.makeUser('buyer4');
  const admin = await fx.makeUser('admin3', { admin: true });
  const orderId = await fx.createOrder(buyer, fx.categoryA.id);
  const ticket = await fx.ticketFor(orderId);

  const otherEvent = await fx.must(fx.service.from('events').insert({ organization_id: fx.org.id, name: 'Outro Evento', year: 2026, slug: `cat-rpc-other-${fx.suffix}`, is_active: true, registration_enabled: true, starts_at: '2026-12-01T12:00:00-03:00', min_age: 0 }).select('id').single(), 'other event');
  const otherCategory = await fx.must(fx.service.from('ticket_categories').insert({ event_id: otherEvent.id, name: 'Outra', slug: `cat-rpc-othercat-${fx.suffix}`, sort_order: 1, is_active: true, capacity: 10 }).select('id').single(), 'other category');

  // Cortesia ja confirma o pedido na hora -- passa o override valido pra
  // garantir que o teste exercite a validacao de evento (nao o bloqueio de
  // pagamento, ja coberto pelos testes acima).
  const result = await admin.rpc('admin_update_ticket_category', { p_ticket_id: ticket.id, p_ticket_category_id: otherCategory.id, p_confirm_after_payment: true, p_override_reason: 'Teste de validacao de evento.' });
  assert.ok(result.error, 'categoria de outro evento nunca deve ser aceita');
  assert.match(result.error.message, /nao pertence ao evento/);
});
