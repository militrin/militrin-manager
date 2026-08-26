// P0 -- valida em runtime, contra o Supabase local, a correcao de overselling
// de capacidade de categoria (migration 20260904000000): a fonte canonica de
// capacidade agora e order_items (1 item de ingresso = 1 vaga, com ou sem
// titular), nao mais public.participants. Cobre os 15 cenarios pedidos,
// incluindo concorrencia real (2 conexoes simultaneas nas ultimas vagas).
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
  const org = await must(service.from('organizations').insert({ name: 'Capacity Test', slug: `cap-${suffix}` }).select('id').single(), 'org');

  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Capacity', year: 2026, slug: `cap-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');

  async function makeCategory(capacity) {
    const catSuffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: `Cat ${catSuffix}`, slug: `cap-cat-${catSuffix}`, sort_order: 1, is_active: true, capacity }).select('id').single(), 'category');
    await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 100, female_price: 100 }), 'price');
    return category;
  }

  async function makeBuyer() {
    const bSuffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const email = `cap-buyer-${bSuffix}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), 'create buyer');
    await must(service.from('customer_profiles').upsert({ user_id: created.user.id, cpf: generateValidCpf(), full_name: 'Buyer', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');
    return clientFor(email, password);
  }

  async function availableSlots(categoryId) {
    const rows = await must(service.rpc('get_event_ticket_categories', { p_event_id: event.id }), 'get_event_ticket_categories');
    const row = rows.find((r) => r.id === categoryId);
    return { available: row.available_slots, reserved: row.reserved_count, confirmed: row.confirmed_count, pending: row.pending_count };
  }

  async function createOrder(buyer, categoryId, items, opts = {}) {
    const r = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: categoryId, p_gender: 'male', p_quantity: items.length,
      p_payment_method: opts.paymentMethod ?? 'pix', p_buyer_full_name: 'Buyer Test', p_buyer_cpf: generateValidCpf(),
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: `discard-${Date.now()}@qa.local`, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: opts.assignFirstToBuyer ?? true,
      p_items: items, p_client_request_id: `cap-${Date.now()}-${Math.random()}`,
    });
    if (r.error) return { error: r.error };
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return { orderId: row.order_id };
  }

  async function startAsaasPix(orderId, expiresAt) {
    const gatewayPaymentId = `pay_${orderId.slice(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const r = await service.rpc('start_order_payment_pix', {
      p_order_id: orderId, p_pix_code: 'FAKE-PIX-CODE', p_pix_qrcode: 'data:image/svg+xml;utf8,fake',
      p_gateway_payment_id: gatewayPaymentId, p_expires_at: expiresAt, p_provider: 'asaas',
    });
    if (r.error) throw new Error(`start pix: ${JSON.stringify(r.error)}`);
    return gatewayPaymentId;
  }

  async function orderItems(orderId) {
    const { data, error } = await service.from('order_items').select('id,participant_id,status,ticket_category_id,item_kind,item_position').eq('order_id', orderId).order('item_position');
    if (error) throw new Error(JSON.stringify(error));
    return data;
  }

  return { service, org, event, batch, must, makeCategory, makeBuyer, availableSlots, createOrder, startAsaasPix, orderItems, suffix };
}

const fx = await buildFixture();
const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 3600_000).toISOString();

test('capacidade 10, pedido de 1 -> disponivel 9', async () => {
  const category = await fx.makeCategory(10);
  const buyer = await fx.makeBuyer();
  const before = await fx.availableSlots(category.id);
  assert.equal(before.available, 10);

  const { orderId, error } = await fx.createOrder(buyer, category.id, [{ ownership_mode: 'self' }]);
  assert.equal(error, undefined);
  const after = await fx.availableSlots(category.id);
  assert.equal(after.available, 9);
  void orderId;
});

test('capacidade 10, pedido de 3 com apenas 1 titular -> disponivel 7', async () => {
  const category = await fx.makeCategory(10);
  const buyer = await fx.makeBuyer();

  const { orderId, error } = await fx.createOrder(buyer, category.id, [
    { ownership_mode: 'self' }, { ownership_mode: 'unassigned' }, { ownership_mode: 'unassigned' },
  ]);
  assert.equal(error, undefined);
  const items = await fx.orderItems(orderId);
  assert.equal(items.length, 3);
  assert.equal(items.filter((i) => i.participant_id).length, 1, 'so o item self ganha participant_id');

  const after = await fx.availableSlots(category.id);
  assert.equal(after.available, 7, 'os 3 ingressos ocupam 3 vagas mesmo com so 1 titular');
});

test('capacidade 10, pedido de 3 sem nenhum titular (assign_first_to_buyer=false) -> disponivel 7', async () => {
  const category = await fx.makeCategory(10);
  const buyer = await fx.makeBuyer();

  const { orderId, error } = await fx.createOrder(buyer, category.id, [
    { ownership_mode: 'unassigned' }, { ownership_mode: 'unassigned' }, { ownership_mode: 'unassigned' },
  ], { assignFirstToBuyer: false });
  assert.equal(error, undefined);
  const items = await fx.orderItems(orderId);
  assert.equal(items.filter((i) => i.participant_id).length, 0, 'nenhum item deve ter participant_id');

  const after = await fx.availableSlots(category.id);
  assert.equal(after.available, 7, '3 ingressos sem NENHUM titular ainda ocupam 3 vagas');
});

test('nomear titular (ownership_mode=named) durante o checkout nao muda a capacidade ja reservada', async () => {
  const category = await fx.makeCategory(10);
  const buyer = await fx.makeBuyer();
  const before = await fx.availableSlots(category.id);

  // materialize_named_checkout_holders roda DEPOIS da checagem/reserva de
  // capacidade (dentro do mesmo RPC de checkout) -- exatamente o cenario de
  // "nomear titular depois" do ponto de vista da capacidade: a vaga ja foi
  // contabilizada antes de qualquer participant ser criado para este item.
  const { orderId, error } = await fx.createOrder(buyer, category.id, [
    { ownership_mode: 'self' },
    { ownership_mode: 'named', holder_full_name: 'Titular Nomeado', holder_cpf: generateValidCpf() },
    { ownership_mode: 'unassigned' },
  ]);
  assert.equal(error, undefined);

  const items = await fx.orderItems(orderId);
  assert.equal(items.length, 3);
  const named = items[1];
  assert.ok(named.participant_id, 'o item nomeado deve ganhar um participant apos materialize_named_checkout_holders');

  const { data: namedParticipant } = await fx.service.from('participants').select('ticket_category_id').eq('id', named.participant_id).single();
  assert.equal(namedParticipant.ticket_category_id, null, 'achado documentado: participant projetado de titular nomeado nunca recebe ticket_category_id');

  const after = await fx.availableSlots(category.id);
  assert.equal(after.available, before.available - 3, 'nomear o titular nao consome vaga extra nem deixa de contar a que ja existia');
});

test('remover/trocar titular de um order_item nao altera a capacidade', async () => {
  const category = await fx.makeCategory(10);
  const buyer = await fx.makeBuyer();
  const { orderId } = await fx.createOrder(buyer, category.id, [
    { ownership_mode: 'self' }, { ownership_mode: 'unassigned' }, { ownership_mode: 'unassigned' },
  ]);
  const before = await fx.availableSlots(category.id);
  assert.equal(before.available, 7);

  const items = await fx.orderItems(orderId);
  const selfItem = items.find((i) => i.participant_id);

  // Manipulacao direta (service role) SOMENTE de participant_id -- o teste e
  // sobre o invariante de capacidade (status nunca muda so por trocar
  // titular), nao sobre as regras de unicidade de titular/identidade, ja
  // cobertas por outra suite (payment-gateway-status-and-tickets).
  await fx.must(fx.service.from('order_items').update({ participant_id: null, ownership_status: 'unassigned' }).eq('id', selfItem.id), 'remove titular');
  let after = await fx.availableSlots(category.id);
  assert.equal(after.available, 7, 'remover titular nao libera nem consome vaga');

  const otherCategory = await fx.makeCategory(5);
  const otherBuyer = await fx.makeBuyer();
  const { orderId: otherOrderId } = await fx.createOrder(otherBuyer, otherCategory.id, [{ ownership_mode: 'self' }]);
  const otherItems = await fx.orderItems(otherOrderId);
  await fx.must(fx.service.from('order_items').update({ participant_id: otherItems[0].participant_id, ownership_status: 'assigned' }).eq('id', selfItem.id), 'troca titular');
  after = await fx.availableSlots(category.id);
  assert.equal(after.available, 7, 'trocar titular tambem nao altera a capacidade da categoria original');
});

test('pagamento confirmado continua ocupando as 3 vagas; emissao dos tickets nao conta 2x', async () => {
  const category = await fx.makeCategory(10);
  const buyer = await fx.makeBuyer();
  const { orderId } = await fx.createOrder(buyer, category.id, [
    { ownership_mode: 'self' }, { ownership_mode: 'unassigned' }, { ownership_mode: 'unassigned' },
  ]);
  const beforePay = await fx.availableSlots(category.id);
  assert.equal(beforePay.available, 7);

  const gatewayPaymentId = await fx.startAsaasPix(orderId, FUTURE);
  const applyResult = await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'confirma pagamento');
  const row = Array.isArray(applyResult) ? applyResult[0] : applyResult;
  assert.equal(row.applied_status, 'paid');

  const afterPay = await fx.availableSlots(category.id);
  assert.equal(afterPay.available, 7, 'pagamento confirmado continua ocupando exatamente 3 vagas');

  const { data: tickets } = await fx.service.from('tickets').select('id,status').eq('order_id', orderId);
  assert.equal(tickets.length, 3, 'os 3 tickets devem ser emitidos');
  assert.ok(tickets.every((t) => t.status === 'active'));

  const afterTickets = await fx.availableSlots(category.id);
  assert.equal(afterTickets.available, 7, 'emitir os tickets nao muda a contagem -- nao ha double counting participant+order_item+ticket');
});

test('expiracao libera exatamente as 3 vagas; segunda execucao nao libera de novo', async () => {
  const category = await fx.makeCategory(10);
  const buyer = await fx.makeBuyer();
  const before = await fx.availableSlots(category.id);
  const { orderId } = await fx.createOrder(buyer, category.id, [
    { ownership_mode: 'self' }, { ownership_mode: 'unassigned' }, { ownership_mode: 'unassigned' },
  ]);
  await fx.startAsaasPix(orderId, PAST);
  assert.equal((await fx.availableSlots(category.id)).available, before.available - 3);

  await fx.must(fx.service.rpc('expire_stale_order_payments', { p_organization_id: fx.org.id }), 'expire');
  const afterFirst = await fx.availableSlots(category.id);
  assert.equal(afterFirst.available, before.available, 'as 3 vagas devem voltar exatamente');

  await fx.must(fx.service.rpc('expire_stale_order_payments', { p_organization_id: fx.org.id }), 'expire de novo');
  const afterSecond = await fx.availableSlots(category.id);
  assert.equal(afterSecond.available, before.available, 'rodar de novo nao libera vaga que ja nao existia mais');
});

test('camiseta/add-on (order_items.item_kind=product) nao ocupa vaga de ingresso', async () => {
  const category = await fx.makeCategory(10);
  const buyer = await fx.makeBuyer();
  const { orderId } = await fx.createOrder(buyer, category.id, [{ ownership_mode: 'self' }]);
  const before = await fx.availableSlots(category.id);
  assert.equal(before.available, 9);

  const storeItem = await fx.must(fx.service.from('store_items').insert({
    organization_id: fx.org.id, event_id: fx.event.id, name: 'Camiseta avulsa', slug: `cap-shirt-${Date.now()}`, price: 50, is_active: true, supply_mode: 'made_to_order',
  }).select('id').single(), 'store item');

  await fx.must(fx.service.from('order_items').insert({
    order_id: orderId, event_id: fx.event.id, item_kind: 'product', store_item_id: storeItem.id,
    quantity: 2, unit_price: 50, discount_amount: 0, final_amount: 100, status: 'reserved',
  }), 'insere item de produto no mesmo pedido');

  const after = await fx.availableSlots(category.id);
  assert.equal(after.available, 9, 'adicionar um produto ao pedido nao muda a capacidade de ingresso');
});

test('pedido multi-categoria: cada categoria desconta so a propria reserva', async () => {
  const categoryA = await fx.makeCategory(10);
  const categoryB = await fx.makeCategory(5);
  const buyerA = await fx.makeBuyer();
  const buyerB = await fx.makeBuyer();

  await fx.createOrder(buyerA, categoryA.id, [{ ownership_mode: 'self' }, { ownership_mode: 'unassigned' }]);
  const afterA = await fx.availableSlots(categoryA.id);
  const afterB1 = await fx.availableSlots(categoryB.id);
  assert.equal(afterA.available, 8, 'categoria A perde 2 vagas');
  assert.equal(afterB1.available, 5, 'categoria B nao e afetada pela reserva na categoria A');

  await fx.createOrder(buyerB, categoryB.id, [{ ownership_mode: 'self' }]);
  const afterA2 = await fx.availableSlots(categoryA.id);
  const afterB2 = await fx.availableSlots(categoryB.id);
  assert.equal(afterA2.available, 8, 'categoria A continua com 8 apos reserva so na categoria B');
  assert.equal(afterB2.available, 4, 'categoria B perde 1 vaga com a propria reserva');
});

test('CRITICO: duas compras concorrentes disputando as ultimas 2 vagas -- apenas uma vence, sem overselling', async () => {
  const category = await fx.makeCategory(2);
  const buyerA = await fx.makeBuyer();
  const buyerB = await fx.makeBuyer();

  const before = await fx.availableSlots(category.id);
  assert.equal(before.available, 2);

  // Disparo verdadeiramente simultaneo: as duas chamadas RPC saem juntas
  // (sem await entre elas), competindo pelo lock em events FOR UPDATE dentro
  // de create_multi_ticket_order_checkout_legacy.
  const [resultA, resultB] = await Promise.all([
    fx.createOrder(buyerA, category.id, [{ ownership_mode: 'self' }, { ownership_mode: 'unassigned' }]),
    fx.createOrder(buyerB, category.id, [{ ownership_mode: 'self' }, { ownership_mode: 'unassigned' }]),
  ]);

  const outcomes = [resultA, resultB];
  const successes = outcomes.filter((o) => !o.error);
  const failures = outcomes.filter((o) => o.error);

  assert.equal(successes.length, 1, 'exatamente uma das duas compras simultaneas deve vencer');
  assert.equal(failures.length, 1, 'a outra deve falhar de forma controlada (excecao de capacidade), nunca as duas passarem');
  assert.match(JSON.stringify(failures[0].error), /Capacidade da categoria insuficiente/);

  const after = await fx.availableSlots(category.id);
  assert.equal(after.available, 0, 'a categoria deve ficar em exatamente 0 vagas -- nunca negativa (overselling)');

  const winningOrderId = successes[0].orderId;
  const items = await fx.orderItems(winningOrderId);
  assert.equal(items.length, 2, 'o pedido vencedor deve ter os 2 ingressos completos, nao parcial');
});

test('cortesia via checkout publico ainda e contabilizada e ainda respeita a capacidade (nao e um bypass silencioso)', async () => {
  const category = await fx.makeCategory(1);
  const buyer = await fx.makeBuyer();

  const { orderId, error } = await fx.createOrder(buyer, category.id, [{ ownership_mode: 'self' }], { paymentMethod: 'courtesy' });
  assert.equal(error, undefined);
  const { data: order } = await fx.service.from('orders').select('status').eq('id', orderId).single();
  assert.equal(order.status, 'confirmed', 'cortesia confirma o pedido imediatamente');

  const after = await fx.availableSlots(category.id);
  assert.equal(after.available, 0, 'cortesia consome a vaga como qualquer outro ingresso confirmado');

  const secondBuyer = await fx.makeBuyer();
  const second = await fx.createOrder(secondBuyer, category.id, [{ ownership_mode: 'self' }], { paymentMethod: 'courtesy' });
  assert.ok(second.error, 'uma segunda cortesia sem vaga deve ser bloqueada pelo mesmo gate de capacidade do checkout publico');
});

test('fluxo legado (participant sem nenhum order_item vinculado) continua contando pra capacidade', async () => {
  const category = await fx.makeCategory(10);
  const before = await fx.availableSlots(category.id);
  assert.equal(before.available, 10);

  // Simula um registro puramente legado (create_registration, hoje
  // desativado) -- um participant com ticket_category_id preenchido e SEM
  // nenhum order_items vinculado.
  const legacyParticipant = await fx.must(fx.service.from('participants').insert({
    event_id: fx.event.id, organization_id: fx.org.id, full_name: 'Legado Puro', cpf: generateValidCpf(),
    birth_date: '1990-01-01', gender: 'male', phone: '11999990000', email: `legacy-${Date.now()}@qa.local`, city: 'Itapiranga',
    registration_status: 'pending', reservation_status: 'pending', ticket_category_id: category.id, batch_id: fx.batch.id,
  }).select('id').single(), 'participant legado puro');

  const after = await fx.availableSlots(category.id);
  assert.equal(after.available, 9, 'participant legado sem order_item ainda ocupa 1 vaga via o residuo legacy_stats');

  await fx.must(fx.service.from('participants').update({ reservation_status: 'confirmed', registration_status: 'confirmed' }).eq('id', legacyParticipant.id), 'confirma legado');
  const afterConfirm = await fx.availableSlots(category.id);
  assert.equal(afterConfirm.available, 9, 'confirmar o legado continua ocupando a mesma vaga (nao soma 2x)');
});

test('nenhum ingresso e contado 2x entre participants + order_items + tickets', async () => {
  const category = await fx.makeCategory(10);
  const buyer = await fx.makeBuyer();
  const { orderId } = await fx.createOrder(buyer, category.id, [{ ownership_mode: 'self' }], { paymentMethod: 'courtesy' });
  const items = await fx.orderItems(orderId);
  assert.equal(items.length, 1);
  assert.ok(items[0].participant_id, 'item self tem participant_id (linkado) E order_item E, apos confirmar, ticket -- as 3 camadas existem pro MESMO ingresso');

  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', orderId);
  assert.equal(tickets.length, 1);

  const after = await fx.availableSlots(category.id);
  assert.equal(after.available, 9, 'com participant + order_item + ticket todos existindo pro mesmo ingresso, a vaga so e contada 1 vez');
});
