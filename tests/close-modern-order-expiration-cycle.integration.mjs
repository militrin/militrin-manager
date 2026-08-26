// P0 -- valida em runtime, contra o Supabase local, o fechamento do ciclo de
// expiracao moderna feito pela migration 20260903000000
// (close_modern_order_expiration_cycle): expire_stale_order_payments()
// agora e de fato acionavel (cron), e _apply_terminal_order_payment_status()
// agora tambem libera a reserva em public.participants (a mesma linha que
// get_event_ticket_categories() usa pra calcular available_slots), sem
// depender de orders.participant_id (legado, pode ser null).
//
// Roda contra o Supabase local (`supabase start` / `supabase db reset`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

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
  const org = await must(service.from('organizations').insert({ name: 'Close Expiration Cycle Test', slug: `close-exp-${suffix}` }).select('id').single(), 'org');

  const buyerEmail = `close-exp-buyer-${suffix}@qa.local`;
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'create buyer');
  await must(service.from('customer_profiles').upsert({ user_id: buyerCreated.user.id, cpf: '11144477735', full_name: 'Buyer', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');

  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Close Expiration', year: 2026, slug: `close-exp-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  // Capacidade pequena e conhecida -- deixa a asserção de "vaga liberada" em
  // available_slots inequívoca (sobe/desce em unidades exatas, sem precisar
  // adivinhar quanto já existia de outros testes).
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-close-${suffix}`, sort_order: 1, is_active: true, capacity: 10 }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 100, female_price: 100 }), 'price');

  const buyer = await clientFor(buyerEmail, password);

  async function availableSlots() {
    const rows = await must(service.rpc('get_event_ticket_categories', { p_event_id: event.id }), 'get_event_ticket_categories');
    const row = rows.find((r) => r.id === category.id);
    return { available: row.available_slots, reserved: row.reserved_count, confirmed: row.confirmed_count };
  }

  async function createOrder(quantity = 1) {
    const items = Array.from({ length: quantity }, (_, index) => ({ ownership_mode: index === 0 ? 'self' : 'unassigned' }));
    const r = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: category.id, p_gender: 'male', p_quantity: quantity,
      p_payment_method: 'pix', p_buyer_full_name: 'Buyer Test', p_buyer_cpf: generateValidCpf(),
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_items: items, p_client_request_id: `close-exp-${Date.now()}-${Math.random()}`,
    });
    if (r.error) throw new Error(`create order (qty=${quantity}): ${JSON.stringify(r.error)}`);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return row.order_id;
  }

  async function startAsaasPix(orderId, expiresAt) {
    const gatewayPaymentId = `pay_${orderId.slice(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const r = await buyer.rpc('start_order_payment_pix', {
      p_order_id: orderId, p_pix_code: 'FAKE-PIX-CODE', p_pix_qrcode: 'data:image/svg+xml;utf8,fake',
      p_gateway_payment_id: gatewayPaymentId, p_expires_at: expiresAt, p_provider: 'asaas',
    });
    if (r.error) throw new Error(`start pix: ${JSON.stringify(r.error)}`);
    return gatewayPaymentId;
  }

  async function orderItemIds(orderId) {
    const { data, error } = await service.from('order_items').select('id,participant_id,status').eq('order_id', orderId);
    if (error) throw new Error(JSON.stringify(error));
    return data;
  }

  async function participantsFor(orderId) {
    const items = await orderItemIds(orderId);
    const ids = items.map((i) => i.participant_id).filter(Boolean);
    if (ids.length === 0) return [];
    const { data, error } = await service.from('participants').select('id,reservation_status,registration_status,reservation_released_at').in('id', ids);
    if (error) throw new Error(JSON.stringify(error));
    return data;
  }

  return { service, buyer, org, event, category, must, createOrder, startAsaasPix, availableSlots, orderItemIds, participantsFor, suffix };
}

const fx = await buildFixture();
const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 3600_000).toISOString();

test('exatamente 1 pedido moderno PIX pendente e vencido: expira payment/order/order_items, libera participants e a vaga volta em available_slots', async () => {
  const before = await fx.availableSlots();

  const orderId = await fx.createOrder(1);
  await fx.startAsaasPix(orderId, PAST);

  const afterReserve = await fx.availableSlots();
  assert.equal(afterReserve.available, before.available - 1, 'reservar 1 ingresso deve consumir exatamente 1 vaga');

  const expiredCount = await fx.must(fx.service.rpc('expire_stale_order_payments', { p_organization_id: fx.org.id }), 'expire');
  assert.ok(expiredCount >= 1);

  const { data: order } = await fx.service.from('orders').select('status,participant_id').eq('id', orderId).single();
  assert.equal(order.status, 'expired');

  const items = await fx.orderItemIds(orderId);
  assert.ok(items.length >= 1);
  assert.ok(items.every((i) => i.status === 'expired'), 'todos os order_items devem virar expired');

  const { data: payment } = await fx.service.from('payments').select('payment_status,expires_at').eq('order_id', orderId).single();
  assert.equal(payment.payment_status, 'expired');
  assert.equal(payment.expires_at, null);

  const participants = await fx.participantsFor(orderId);
  assert.ok(participants.length >= 1, 'order_items devem ter participant_id vinculado (mesmo em pedido moderno)');
  for (const p of participants) {
    assert.equal(p.reservation_status, 'expired');
    assert.equal(p.registration_status, 'cancelled');
    assert.ok(p.reservation_released_at, 'reservation_released_at deve estar preenchido');
  }

  const after = await fx.availableSlots();
  assert.equal(after.available, before.available, 'a vaga liberada deve voltar ao valor anterior a reserva');
});

test('idempotencia: rodar expire_stale_order_payments 2x nao muda nada na segunda vez', async () => {
  const orderId = await fx.createOrder(1);
  await fx.startAsaasPix(orderId, PAST);

  await fx.must(fx.service.rpc('expire_stale_order_payments', { p_organization_id: fx.org.id }), 'expire 1');
  const participantsAfterFirst = await fx.participantsFor(orderId);
  const releasedAtFirst = participantsAfterFirst.map((p) => p.reservation_released_at).sort();

  await fx.must(fx.service.rpc('expire_stale_order_payments', { p_organization_id: fx.org.id }), 'expire 2');
  const participantsAfterSecond = await fx.participantsFor(orderId);
  const releasedAtSecond = participantsAfterSecond.map((p) => p.reservation_released_at).sort();

  assert.deepEqual(releasedAtSecond, releasedAtFirst, 'segunda execucao nao deve retocar participants ja liberados');
  const { data: order } = await fx.service.from('orders').select('status').eq('id', orderId).single();
  assert.equal(order.status, 'expired');
});

test('pedido pago nao e tocado pela expiracao', async () => {
  const before = await fx.availableSlots();
  const orderId = await fx.createOrder(1);
  const gatewayPaymentId = await fx.startAsaasPix(orderId, PAST);

  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'confirma pagamento antes da expiracao rodar');

  await fx.must(fx.service.rpc('expire_stale_order_payments', { p_organization_id: fx.org.id }), 'expire depois do pagamento confirmado');

  const { data: order } = await fx.service.from('orders').select('status').eq('id', orderId).single();
  assert.equal(order.status, 'confirmed', 'pedido pago nunca deve ser expirado retroativamente');
  const items = await fx.orderItemIds(orderId);
  assert.ok(items.every((i) => i.status === 'confirmed'), 'order_items de pedido pago devem estar confirmed, nunca expired');
  const participants = await fx.participantsFor(orderId);
  for (const p of participants) {
    assert.notEqual(p.reservation_status, 'expired', 'participante de pedido pago nao deve ser marcado como expirado');
  }
  // NOTA (achado separado, fora do escopo desta correcao): confirm_order_
  // payment_and_issue_tickets() nao atualiza participants.reservation_status
  // pra 'confirmed' no fluxo moderno -- ele fica parado em 'pending' mesmo
  // com o pedido pago. get_event_ticket_categories() so reflete isso no
  // reserved_count/confirmed_count internos; o que importa aqui e que
  // available_slots (capacidade realmente livre) NUNCA muda so por causa da
  // expiracao rodar em cima de um pedido ja pago.
  const after = await fx.availableSlots();
  assert.equal(after.available, before.available - 1, 'a vaga do pedido confirmado deve continuar ocupada -- expirar por cima nao deve liberar nada');
});

test('pedido ainda dentro do prazo nao e tocado pela expiracao', async () => {
  const orderId = await fx.createOrder(1);
  await fx.startAsaasPix(orderId, FUTURE);

  await fx.must(fx.service.rpc('expire_stale_order_payments', { p_organization_id: fx.org.id }), 'expire com prazo futuro');

  const { data: order } = await fx.service.from('orders').select('status').eq('id', orderId).single();
  assert.equal(order.status, 'pending');
  const { data: payment } = await fx.service.from('payments').select('payment_status,expires_at').eq('order_id', orderId).single();
  assert.equal(payment.payment_status, 'pending');
  assert.ok(payment.expires_at, 'expires_at futuro nao deve ser limpo');
  const participants = await fx.participantsFor(orderId);
  for (const p of participants) assert.equal(p.reservation_status, 'pending');
});

test('pedido multi-item (3 ingressos): as 3 vagas sao ocupadas e liberadas, com ou sem titular', async () => {
  const before = await fx.availableSlots();
  const orderId = await fx.createOrder(3);
  await fx.startAsaasPix(orderId, PAST);

  const items = await fx.orderItemIds(orderId);
  assert.equal(items.length, 3, 'pedido deve ter exatamente 3 order_items');
  // create_multi_ticket_order_checkout so cria public.participants pro item
  // com ownership_mode='self' -- itens 'unassigned' ficam com participant_id
  // null. Isso e esperado e correto: a fonte canonica de capacidade agora e
  // order_items (migration 20260904000000), nao mais participants -- por
  // isso a vaga e ocupada pelos 3 itens independente de titular.
  const assignedItems = items.filter((i) => i.participant_id);
  assert.equal(assignedItems.length, 1, 'apenas o item self tem participant_id vinculado (comportamento esperado do checkout, nao da capacidade)');

  const afterReserve = await fx.availableSlots();
  assert.equal(afterReserve.available, before.available - 3, 'os 3 ingressos devem consumir 3 vagas, independente de titular');

  await fx.must(fx.service.rpc('expire_stale_order_payments', { p_organization_id: fx.org.id }), 'expire multi-item');

  const itemsAfter = await fx.orderItemIds(orderId);
  assert.ok(itemsAfter.every((i) => i.status === 'expired'), 'todos os 3 order_items devem expirar, com ou sem participant_id');

  const participants = await fx.participantsFor(orderId);
  assert.equal(participants.length, assignedItems.length, 'so o participante realmente vinculado deve ser encontrado');
  for (const p of participants) {
    assert.equal(p.reservation_status, 'expired');
    assert.equal(p.registration_status, 'cancelled');
    assert.ok(p.reservation_released_at);
  }

  const after = await fx.availableSlots();
  assert.equal(after.available, before.available, 'as 3 vagas devem voltar, mesmo os 2 itens sem titular nunca terem tido participant');
});

test('funciona sem depender de orders.participant_id (coluna legada anulada explicitamente)', async () => {
  const before = await fx.availableSlots();
  const orderId = await fx.createOrder(1);
  await fx.startAsaasPix(orderId, PAST);

  const { data: orderBefore } = await fx.service.from('orders').select('participant_id').eq('id', orderId).single();
  // Simula exatamente o cenario moderno descrito na auditoria: orders.participant_id
  // e coluna LEGADA e pode ser null num pedido real. Anulamos explicitamente
  // aqui pra provar que a cascata de expiracao (que so usa order_items.participant_id)
  // nao depende dela, mesmo que hoje o RPC de checkout ainda a preencha.
  await fx.must(fx.service.from('orders').update({ participant_id: null }).eq('id', orderId), 'anula participant_id legado');
  void orderBefore;

  await fx.must(fx.service.rpc('expire_stale_order_payments', { p_organization_id: fx.org.id }), 'expire sem orders.participant_id');

  const { data: order } = await fx.service.from('orders').select('status,participant_id').eq('id', orderId).single();
  assert.equal(order.status, 'expired', 'expiracao deve funcionar mesmo com orders.participant_id null');
  assert.equal(order.participant_id, null);

  const participants = await fx.participantsFor(orderId);
  assert.ok(participants.length >= 1);
  for (const p of participants) assert.equal(p.reservation_status, 'expired');

  const after = await fx.availableSlots();
  assert.equal(after.available, before.available, 'vaga liberada normalmente mesmo sem orders.participant_id');
});

test('cortesia (payment_method=courtesy, ja paga, sem expires_at) nunca e varrida pela expiracao', async () => {
  // Simula deliberadamente o estado final de uma cortesia (100% desconto):
  // payment_status ja nasce 'paid' e expires_at nunca chega a ser setado --
  // a mesma condicao que o WHERE de expire_stale_order_payments exige
  // (payment_status='pending' AND expires_at is not null) garante que este
  // caminho nunca e tocado, independentemente de como a cortesia e originada.
  const orderId = await fx.createOrder(1);
  const { data: payment } = await fx.service.from('payments').select('id').eq('order_id', orderId).single();
  await fx.must(fx.service.from('payments').update({ payment_method: 'courtesy', payment_status: 'paid', expires_at: null, paid_at: new Date().toISOString() }).eq('id', payment.id), 'simula cortesia paga');
  await fx.must(fx.service.from('orders').update({ status: 'confirmed' }).eq('id', orderId), 'confirma pedido cortesia');

  await fx.must(fx.service.rpc('expire_stale_order_payments', { p_organization_id: fx.org.id }), 'expire nao deve tocar cortesia');

  const { data: paymentAfter } = await fx.service.from('payments').select('payment_status').eq('id', payment.id).single();
  assert.equal(paymentAfter.payment_status, 'paid', 'cortesia paga nunca deve virar expired');
  const { data: orderAfter } = await fx.service.from('orders').select('status').eq('id', orderId).single();
  assert.equal(orderAfter.status, 'confirmed');
});
