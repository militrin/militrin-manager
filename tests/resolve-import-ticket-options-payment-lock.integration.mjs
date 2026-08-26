// Segunda parte da auditoria "fechar todos os writers de categoria antes de
// aplicar a 906/907" -- resolve_import_ticket_options (fluxo de correcao de
// importacao) e MAIS sensivel que admin_update_ticket_category porque, alem
// da categoria/lote, ela recalcula incondicionalmente
// order_items.unit_price/final_amount e orders.base_amount/final_amount.
// Migration 20260907000000 bloqueia essa RPC quando o pedido ja esta
// pago/confirmado (mesma semantica canonica de admin_update_ticket_category)
// ou o ticket ja teve check-in -- SEM override administrativo (ao contrario
// da 906): a tarefa foi explicita que uma correcao de importacao
// pos-pagamento exige um fluxo de regularizacao financeira proprio, nunca
// uma alteracao silenciosa de categoria+preco.
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
  const org = await must(service.from('organizations').insert({ name: 'Import Options Lock Test', slug: `imp-lock-${suffix}` }).select('id').single(), 'org');

  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Import Lock', year: 2026, slug: `imp-lock-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const categoryA = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'A', slug: `imp-lock-a-${suffix}`, sort_order: 1, is_active: true, capacity: 10 }).select('id').single(), 'category a');
  const categoryB = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'B', slug: `imp-lock-b-${suffix}`, sort_order: 2, is_active: true, capacity: 10 }).select('id').single(), 'category b');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: categoryA.id, male_price: 100, female_price: 100 }), 'price a');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: categoryB.id, male_price: 150, female_price: 150 }), 'price b');

  async function makeUser(label, { admin = false } = {}) {
    const email = `imp-lock-${label}-${suffix}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `create ${label}`);
    await must(service.from('customer_profiles').upsert({ user_id: created.user.id, cpf: generateValidCpf(), full_name: label, birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), `${label} profile`);
    if (admin) {
      const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
      await must(service.from('organization_members').insert({ organization_id: org.id, user_id: created.user.id, is_owner: true, is_active: true }), `${label} org member`);
      await must(service.from('admin_users').insert({ user_id: created.user.id, role_id: ownerRole.id, is_active: true }), `${label} admin_users`);
    }
    return clientFor(email, password);
  }

  async function createPixOrder(buyer, categoryId) {
    const r = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: categoryId, p_gender: 'male', p_quantity: 1,
      p_payment_method: 'pix', p_buyer_full_name: 'Buyer Test', p_buyer_cpf: generateValidCpf(),
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: `discard-${Date.now()}@qa.local`, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_items: [{ ownership_mode: 'self' }], p_client_request_id: `imp-lock-${Date.now()}-${Math.random()}`,
    });
    if (r.error) throw new Error(`create order: ${JSON.stringify(r.error)}`);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return row.order_id;
  }

  async function orderItemFor(orderId) {
    const { data } = await service.from('order_items').select('id,ticket_category_id,batch_id,unit_price,final_amount,status').eq('order_id', orderId).single();
    return data;
  }

  // simulate_fake_gateway_payment_paid recusa (SIMULATION_NOT_ALLOWED)
  // qualquer pedido cujo pagamento nao esteja explicitamente associado ao
  // provider 'fake' -- precisa registrar isso via start_order_payment_pix
  // antes de simular (mesmo padrao de tests/simulate-fake-gateway-payment.integration.mjs).
  async function startFakePix(buyer, orderId) {
    const gatewayPaymentId = `fake_${orderId.slice(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const r = await buyer.rpc('start_order_payment_pix', {
      p_order_id: orderId, p_pix_code: 'FAKE-PIX-CODE', p_pix_qrcode: 'data:image/svg+xml;utf8,fake',
      p_gateway_payment_id: gatewayPaymentId, p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      p_provider: 'fake',
    });
    if (r.error) throw new Error(`start pix: ${JSON.stringify(r.error)}`);
    return gatewayPaymentId;
  }

  async function snapshot(orderId, orderItemId) {
    const order = await must(service.from('orders').select('base_amount,final_amount,status,payment_id').eq('id', orderId).single(), 'order snapshot');
    const item = await must(service.from('order_items').select('ticket_category_id,batch_id,unit_price,final_amount,status').eq('id', orderItemId).single(), 'item snapshot');
    return { order, item };
  }

  return { service, org, event, batch, categoryA, categoryB, must, makeUser, createPixOrder, orderItemFor, snapshot, startFakePix, suffix };
}

const fx = await buildFixture();

test('antes do pagamento, correcao de importacao continua funcionando (categoria, lote e valores)', async () => {
  const buyer = await fx.makeUser('buyer1');
  const admin = await fx.makeUser('admin1', { admin: true });
  const orderId = await fx.createPixOrder(buyer, fx.categoryA.id);
  const item = await fx.orderItemFor(orderId);

  const result = await admin.rpc('resolve_import_ticket_options', { p_order_item_id: item.id, p_ticket_category_id: fx.categoryB.id, p_batch_id: fx.batch.id });
  assert.equal(result.error, null, 'antes do pagamento a correcao deve funcionar exatamente como antes');

  const after = await fx.snapshot(orderId, item.id);
  assert.equal(after.item.ticket_category_id, fx.categoryB.id);
  assert.equal(Number(after.item.unit_price), 150, 'preco deve ser recalculado pra categoria B');
  assert.equal(Number(after.order.base_amount), 150);
  assert.equal(Number(after.order.final_amount), 150);
});

test('pedido confirmado/pago bloqueia a correcao e nao altera categoria, lote nem valores', async () => {
  const buyer = await fx.makeUser('buyer2');
  const admin = await fx.makeUser('admin2', { admin: true });
  const orderId = await fx.createPixOrder(buyer, fx.categoryA.id);
  const item = await fx.orderItemFor(orderId);

  await fx.startFakePix(buyer, orderId);
  const paid = await buyer.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId });
  assert.equal(paid.error, null, 'simulacao de pagamento deve suceder');
  const before = await fx.snapshot(orderId, item.id);
  assert.equal(before.order.status, 'confirmed', 'pedido deve estar confirmado apos o pagamento simulado');

  const blocked = await admin.rpc('resolve_import_ticket_options', { p_order_item_id: item.id, p_ticket_category_id: fx.categoryB.id, p_batch_id: fx.batch.id });
  assert.ok(blocked.error, 'correcao de importacao pos-pagamento deve ser recusada, sem override possivel');
  assert.match(blocked.error.message, /ja esta pago.*confirmado/i);

  const after = await fx.snapshot(orderId, item.id);
  assert.equal(after.item.ticket_category_id, before.item.ticket_category_id, 'categoria nao pode mudar apos bloqueio');
  assert.equal(after.item.batch_id, before.item.batch_id, 'lote nao pode mudar apos bloqueio');
  assert.equal(Number(after.item.unit_price), Number(before.item.unit_price), 'preco do item nao pode mudar apos bloqueio');
  assert.equal(Number(after.order.base_amount), Number(before.order.base_amount), 'valor do pedido nao pode mudar apos bloqueio');
  assert.equal(Number(after.order.final_amount), Number(before.order.final_amount), 'valor final do pedido nao pode mudar apos bloqueio');
});

test('payments.payment_status=paid bloqueia mesmo com orders.status revertido (mesma semantica canonica da 906)', async () => {
  const buyer = await fx.makeUser('buyer3');
  const admin = await fx.makeUser('admin3', { admin: true });
  const orderId = await fx.createPixOrder(buyer, fx.categoryA.id);
  const item = await fx.orderItemFor(orderId);

  await fx.startFakePix(buyer, orderId);
  const paid = await buyer.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId });
  assert.equal(paid.error, null);

  // Diverge orders.status/order_items.status de proposito, mantendo
  // payments.payment_status='paid' -- exatamente a divergencia que motivou
  // reescrever a 906 pra nao confiar exclusivamente em orders.status.
  await fx.must(fx.service.from('orders').update({ status: 'expired' }).eq('id', orderId), 'diverge order status');
  await fx.must(fx.service.from('order_items').update({ status: 'reserved' }).eq('id', item.id), 'diverge item status');

  const blocked = await admin.rpc('resolve_import_ticket_options', { p_order_item_id: item.id, p_ticket_category_id: fx.categoryB.id, p_batch_id: fx.batch.id });
  assert.ok(blocked.error, 'payment_status=paid sozinho ja deve bloquear a correcao de importacao');
});

test('ticket com check-in bloqueia a correcao de importacao', async () => {
  const buyer = await fx.makeUser('buyer4');
  const admin = await fx.makeUser('admin4', { admin: true });
  const orderId = await fx.createPixOrder(buyer, fx.categoryA.id);
  const item = await fx.orderItemFor(orderId);

  await fx.startFakePix(buyer, orderId);
  const paid = await buyer.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId });
  assert.equal(paid.error, null);
  const { data: ticket } = await fx.service.from('tickets').select('id').eq('order_item_id', item.id).single();
  await fx.must(fx.service.from('tickets').update({ status: 'used', used_at: new Date().toISOString() }).eq('id', ticket.id), 'mark checked in');

  const blocked = await admin.rpc('resolve_import_ticket_options', { p_order_item_id: item.id, p_ticket_category_id: fx.categoryB.id, p_batch_id: fx.batch.id });
  assert.ok(blocked.error, 'check-in ja realizado deve bloquear a correcao de importacao');
});

test('usuario sem participants.edit_basic e sem acesso a organizacao nao consegue chamar a RPC', async () => {
  const buyer = await fx.makeUser('buyer5');
  const outsider = await fx.makeUser('outsider1');
  const orderId = await fx.createPixOrder(buyer, fx.categoryA.id);
  const item = await fx.orderItemFor(orderId);

  const result = await outsider.rpc('resolve_import_ticket_options', { p_order_item_id: item.id, p_ticket_category_id: fx.categoryB.id, p_batch_id: fx.batch.id });
  assert.ok(result.error, 'usuario sem permissao/organizacao deve ser recusado pela propria RPC');
});
