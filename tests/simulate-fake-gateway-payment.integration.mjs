// UX do pagamento PIX + simulacao segura no provider fake -- P0: a RPC
// simulate_fake_gateway_payment_paid (migration 20260902000000) e o unico
// caminho backend que o botao "Simular pagamento aprovado" pode disparar.
// Roda contra o Supabase local (`supabase start`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

function generateValidCpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  function checkDigit(nums) {
    let sum = 0, weight = nums.length + 1;
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
  const org = await must(service.from('organizations').insert({ name: 'Simulate Fake Payment Test', slug: `sim-fake-${suffix}` }).select('id').single(), 'org');

  const buyerEmail = `sim-fake-buyer-${suffix}@qa.local`;
  const outsiderEmail = `sim-fake-outsider-${suffix}@qa.local`;
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'create buyer');
  const outsiderCreated = await must(service.auth.admin.createUser({ email: outsiderEmail, password, email_confirm: true }), 'create outsider');
  await must(service.from('customer_profiles').upsert({ user_id: buyerCreated.user.id, cpf: generateValidCpf(), full_name: 'Comprador Sim', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');
  await must(service.from('customer_profiles').upsert({ user_id: outsiderCreated.user.id, cpf: generateValidCpf(), full_name: 'Estranho Sim', birth_date: '1991-01-01', phone: '11999990002', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'outsider profile');

  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Simulate Fake', year: 2026, slug: `sim-fake-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 110, female_price: 110, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-sim-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 110, female_price: 110 }), 'price');

  const buyer = await clientFor(buyerEmail, password);
  const outsider = await clientFor(outsiderEmail, password);

  async function createOrder() {
    const r = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: category.id, p_gender: 'male', p_quantity: 1,
      p_payment_method: 'pix', p_buyer_full_name: 'Comprador Sim', p_buyer_cpf: generateValidCpf(),
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_items: [{ ownership_mode: 'self' }], p_client_request_id: `sim-fake-${Date.now()}-${Math.random()}`,
    });
    if (r.error) throw new Error(`create order: ${JSON.stringify(r.error)}`);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return row.order_id;
  }

  async function startFakePix(orderId) {
    const gatewayPaymentId = `fake_${orderId.slice(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const r = await buyer.rpc('start_order_payment_pix', {
      p_order_id: orderId, p_pix_code: 'FAKE-PIX-CODE', p_pix_qrcode: 'data:image/svg+xml;utf8,fake',
      p_gateway_payment_id: gatewayPaymentId, p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      p_provider: 'fake',
    });
    if (r.error) throw new Error(`start pix: ${JSON.stringify(r.error)}`);
    return gatewayPaymentId;
  }

  return { service, buyer, outsider, org, event, must, createOrder, startFakePix };
}

const fx = await buildFixture();

test('chamada direta com provider nao-fake (ex.: asaas) e recusada -- validado no banco, nao so na UI', async () => {
  const orderId = await fx.createOrder();
  const gatewayPaymentId = `asaas_${orderId.slice(0, 8)}_${Date.now()}`;
  // Simula um pagamento real da Asaas ja associado ao pedido.
  await fx.must(fx.buyer.rpc('start_order_payment_pix', {
    p_order_id: orderId, p_pix_code: 'ASAAS-PIX-CODE', p_pix_qrcode: 'data:image/png;base64,fake',
    p_gateway_payment_id: gatewayPaymentId, p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    p_provider: 'asaas',
  }), 'start pix asaas');

  const result = await fx.buyer.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId });
  assert.ok(result.error, 'simulacao deveria ser recusada para pagamento com provider=asaas');
  assert.match(result.error.message, /SIMULATION_NOT_ALLOWED/);

  const { data: payment } = await fx.service.from('payments').select('payment_status').eq('order_id', orderId).single();
  assert.equal(payment.payment_status, 'pending', 'nada deve mudar quando a simulacao e recusada');
});

test('usuario sem acesso ao pedido nao consegue simular pagamento de outra pessoa', async () => {
  const orderId = await fx.createOrder();
  await fx.startFakePix(orderId);
  const result = await fx.outsider.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId });
  assert.ok(result.error, 'outsider nao deveria conseguir simular pagamento de pedido alheio');
});

test('simulacao confirma o pagamento e emite exatamente um ticket', async () => {
  const orderId = await fx.createOrder();
  await fx.startFakePix(orderId);

  const result = await fx.must(fx.buyer.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId }), 'simulate');
  const row = Array.isArray(result) ? result[0] : result;
  assert.equal(row.applied_status, 'paid');

  const { data: order } = await fx.service.from('orders').select('status').eq('id', orderId).single();
  assert.equal(order.status, 'confirmed');
  const { data: orderItems } = await fx.service.from('order_items').select('status').eq('order_id', orderId);
  assert.equal(orderItems.length, 1, 'materializacao do item nao duplica');
  assert.equal(orderItems[0].status, 'confirmed');
  const { data: tickets } = await fx.service.from('tickets').select('id,status').eq('order_id', orderId);
  assert.equal(tickets.length, 1, 'deve emitir exatamente um ticket');
  assert.equal(tickets[0].status, 'active');
});

test('clique duplo (chamada repetida) na simulacao nao duplica ticket nem quebra titularidade', async () => {
  const orderId = await fx.createOrder();
  await fx.startFakePix(orderId);

  await fx.must(fx.buyer.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId }), 'simulate 1');
  const { data: ticketAfterFirst } = await fx.service.from('tickets').select('id').eq('order_id', orderId).single();

  // Segundo clique -- nao deveria dar erro (idempotente) nem duplicar.
  const second = await fx.buyer.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId });
  assert.equal(second.error, null, second.error?.message);

  const { data: ticketsAfterSecond } = await fx.service.from('tickets').select('id').eq('order_id', orderId);
  assert.equal(ticketsAfterSecond.length, 1);
  assert.equal(ticketsAfterSecond[0].id, ticketAfterFirst.id, 'deve continuar sendo o MESMO ticket');
});

test('duas chamadas concorrentes de simulacao continuam com exatamente 1 ticket', async () => {
  const orderId = await fx.createOrder();
  await fx.startFakePix(orderId);

  const [r1, r2] = await Promise.all([
    fx.buyer.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId }),
    fx.buyer.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId }),
  ]);
  assert.equal(r1.error, null, r1.error?.message);
  assert.equal(r2.error, null, r2.error?.message);

  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', orderId);
  assert.equal(tickets.length, 1);
});

test('refresh (nova consulta) apos simular mantem o estado confirmado', async () => {
  const orderId = await fx.createOrder();
  await fx.startFakePix(orderId);
  await fx.must(fx.buyer.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId }), 'simulate');

  // Simula um "F5": nova consulta independente, exatamente o que
  // getPublicOrderSnapshotAction faria ao remontar a tela.
  const snapshotAfterRefresh = await fx.must(fx.buyer.rpc('get_order_checkout_snapshot', { p_order_id: orderId }), 'refresh snapshot');
  const row = Array.isArray(snapshotAfterRefresh) ? snapshotAfterRefresh[0] : snapshotAfterRefresh;
  assert.equal(row.payment_status, 'paid');
  assert.equal(row.order_status, 'confirmed');
});
