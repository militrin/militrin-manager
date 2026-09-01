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

  // ---- helpers de produto "compre junto" (item_kind='product'), pra
  // auditoria do vazamento de reserved_quantity (store_item_inventory /
  // event_kit_item_variant_inventory) em _apply_terminal_order_payment_status
  // e remove_cart_order_item -- ver 20260926000000_fix_product_stock_
  // reservation_release.sql. ----
  async function createStoreItem(totalQuantity) {
    const itemSuffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const item = await must(service.from('store_items').insert({
      organization_id: org.id, event_id: event.id, name: `Produto Teste ${itemSuffix}`, slug: `produto-teste-${itemSuffix}`,
      price: 10, supply_mode: 'stock', visibility: 'public', is_active: true, requires_variant: false,
    }).select('id').single(), 'create store item');
    await must(service.from('store_item_inventory').insert({
      organization_id: org.id, event_id: event.id, store_item_id: item.id, variant_id: null,
      total_quantity: totalQuantity, reserved_quantity: 0, delivered_quantity: 0,
    }), 'create store item inventory');
    return item.id;
  }

  // Item vinculado ao kit do evento (linked_event_kit_item_id): estoque real
  // vive em event_kit_item_variant_inventory, NUNCA em store_item_inventory
  // (roteamento de reserve_store_item_stock/release_store_item_reservation/
  // deliver_store_item_stock, 20260854000000). remove_cart_order_item tocava
  // store_item_inventory direto e nunca liberava esse estoque -- exatamente o
  // caso que este fixture prova.
  async function createLinkedStoreItem(totalQuantity) {
    const itemSuffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const kitItem = await must(service.from('event_kit_items').insert({
      organization_id: org.id, event_id: event.id, name: `Kit Item ${itemSuffix}`, slug: `kit-item-${itemSuffix}`,
      item_type: 'other', requires_variant: true, is_required: false, is_active: true, shirt_supply_mode: 'stock',
    }).select('id').single(), 'create event kit item');
    const kitVariant = await must(service.from('event_kit_item_variants').insert({
      kit_item_id: kitItem.id, name: 'Tamanho', value: 'Único', sort_order: 1, is_active: true,
    }).select('id').single(), 'create event kit item variant');
    await must(service.from('event_kit_item_variant_inventory').insert({
      organization_id: org.id, event_id: event.id, kit_item_id: kitItem.id, variant_id: kitVariant.id,
      total_quantity: totalQuantity, reserved_quantity: 0, delivered_quantity: 0,
    }), 'create kit variant inventory');
    const storeItem = await must(service.from('store_items').insert({
      organization_id: org.id, event_id: event.id, name: `Produto Vinculado ${itemSuffix}`, slug: `produto-vinculado-${itemSuffix}`,
      price: 10, supply_mode: 'stock', visibility: 'public', is_active: true, requires_variant: true,
      linked_event_kit_item_id: kitItem.id,
    }).select('id').single(), 'create linked store item');
    const storeVariant = await must(service.from('store_item_variants').insert({
      store_item_id: storeItem.id, name: 'Tamanho', value: 'Único', is_active: true, sort_order: 1,
      linked_event_kit_item_variant_id: kitVariant.id,
    }).select('id').single(), 'create linked store item variant');
    return { storeItemId: storeItem.id, variantId: storeVariant.id, kitItemId: kitItem.id, kitVariantId: kitVariant.id };
  }

  // Pedido SEM ingresso -- so pra anexar produto (add_product_to_cart_order
  // exige um pedido 'pending' existente, mas nao exige item de ingresso
  // nele). Evita consumir a capacidade compartilhada da categoria de
  // ingresso (fx.category, capacity=10) em testes que so importam pra
  // reserva de PRODUTO -- createOrder() sempre emite um ticket de verdade
  // via create_multi_ticket_order_checkout, e testes de reconciliacao nunca
  // liberam esse ticket (so mexem no order_item de produto), o que esgotaria
  // a capacidade compartilhada entre muitos testes no mesmo arquivo.
  async function createProductOnlyOrder() {
    const orderSuffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const order = await must(service.from('orders').insert({
      organization_id: org.id, event_id: event.id, user_id: buyerCreated.user.id, order_number: `PROD-ONLY-${orderSuffix}`,
      status: 'pending', base_amount: 0, final_amount: 0, buyer_type: 'account',
    }).select('id').single(), 'create product-only order');
    // start_order_payment_pix exige um payments row 'pending' ja existente
    // pro pedido (o mesmo que create_multi_ticket_order_checkout ja cria
    // pra pedido de ingresso) -- reproduzido aqui pra permitir o mesmo fluxo
    // PIX -> apply_gateway_payment_status nos testes que so precisam de
    // produto (sem ticket).
    const payment = await must(service.from('payments').insert({
      organization_id: org.id, event_id: event.id, order_id: order.id, amount: 0, final_amount: 0,
      payment_method: 'pix', payment_status: 'pending',
    }).select('id').single(), 'create pending payment for product-only order');
    await must(service.from('orders').update({ payment_id: payment.id }).eq('id', order.id), 'link payment to product-only order');
    return order.id;
  }

  async function addProduct(orderId, storeItemId, quantity, variantId = null) {
    const r = await buyer.rpc('add_product_to_cart_order', {
      p_order_id: orderId, p_store_item_id: storeItemId, p_variant_id: variantId, p_quantity: quantity,
    });
    if (r.error) throw new Error(`add product: ${JSON.stringify(r.error)}`);
    return r.data.order_item_ids[0];
  }

  async function storeInventoryOf(storeItemId) {
    const { data, error } = await service.from('store_item_inventory')
      .select('total_quantity,reserved_quantity,delivered_quantity')
      .eq('store_item_id', storeItemId).is('variant_id', null).single();
    if (error) throw new Error(JSON.stringify(error));
    return data;
  }

  async function kitInventoryOf(kitItemId, variantId) {
    const { data, error } = await service.from('event_kit_item_variant_inventory')
      .select('total_quantity,reserved_quantity,delivered_quantity')
      .eq('kit_item_id', kitItemId).eq('variant_id', variantId).single();
    if (error) throw new Error(JSON.stringify(error));
    return data;
  }

  async function createStandaloneStoreOrderItem(storeItemId, quantity, status = 'reserved') {
    const orderSuffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const storeOrder = await must(service.from('store_orders').insert({
      organization_id: org.id, event_id: event.id, user_id: buyerCreated.user.id, order_number: `LOJA-${orderSuffix}`,
      status: 'pending', payment_status: 'pending', base_amount: 10, final_amount: 10,
    }).select('id').single(), 'create store order');
    const item = await must(service.from('store_order_items').insert({
      store_order_id: storeOrder.id, store_item_id: storeItemId, variant_id: null, quantity, unit_price: 10, final_amount: 10 * quantity, status,
    }).select('id').single(), 'create store order item');
    return item.id;
  }

  return {
    service, buyer, org, event, category, must, createOrder, startAsaasPix, availableSlots, orderItemIds, participantsFor, suffix,
    createStoreItem, createLinkedStoreItem, addProduct, storeInventoryOf, kitInventoryOf, createStandaloneStoreOrderItem, createProductOnlyOrder,
  };
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

// ============================================================
// Reserva de estoque de produto "compre junto" (order_items.item_kind=
// 'product') -- auditoria confirmou que _apply_terminal_order_payment_status
// nunca liberava reserved_quantity, e remove_cart_order_item nunca liberava
// o estoque de item vinculado a kit do evento. Corrigido em
// 20260926000000_fix_product_stock_reservation_release.sql.
// ============================================================

test('adicionar produto ao pedido aumenta reserved_quantity corretamente', async () => {
  const storeItemId = await fx.createStoreItem(20);
  const orderId = await fx.createOrder(1);
  await fx.addProduct(orderId, storeItemId, 3);
  const inv = await fx.storeInventoryOf(storeItemId);
  assert.equal(inv.reserved_quantity, 3);
});

test('expirar PIX libera exatamente a reserva do produto (2 unidades), sem tocar o ingresso', async () => {
  const storeItemId = await fx.createStoreItem(20);
  const orderId = await fx.createOrder(1);
  await fx.addProduct(orderId, storeItemId, 2);
  await fx.startAsaasPix(orderId, PAST);

  const before = await fx.storeInventoryOf(storeItemId);
  assert.equal(before.reserved_quantity, 2, 'reserva deve ficar em 2 antes de expirar');

  await fx.must(fx.service.rpc('expire_stale_order_payments', { p_organization_id: fx.org.id }), 'expire com produto');

  const after = await fx.storeInventoryOf(storeItemId);
  assert.equal(after.reserved_quantity, 0, 'as 2 unidades reservadas do produto devem ser liberadas ao expirar');

  const items = await fx.orderItemIds(orderId);
  assert.ok(items.every((i) => i.status === 'expired'), 'ingresso e produto do mesmo pedido devem expirar juntos');
});

test('pedido misto (1 ingresso + 1 produto) expirado libera capacidade do ingresso E reserva do produto, independentemente', async () => {
  const before = await fx.availableSlots();
  const storeItemId = await fx.createStoreItem(20);
  const orderId = await fx.createOrder(1);
  await fx.addProduct(orderId, storeItemId, 5);
  await fx.startAsaasPix(orderId, PAST);

  assert.equal((await fx.availableSlots()).available, before.available - 1, 'ingresso deve consumir 1 vaga');
  assert.equal((await fx.storeInventoryOf(storeItemId)).reserved_quantity, 5, 'produto deve reservar 5 unidades');

  await fx.must(fx.service.rpc('expire_stale_order_payments', { p_organization_id: fx.org.id }), 'expire misto');

  assert.equal((await fx.availableSlots()).available, before.available, 'vaga do ingresso deve voltar');
  assert.equal((await fx.storeInventoryOf(storeItemId)).reserved_quantity, 0, 'reserva do produto tambem deve ser liberada');
});

test('retry de _apply_terminal_order_payment_status (mesmo payment, 2x) nao libera a reserva do produto duas vezes', async () => {
  const storeItemId = await fx.createStoreItem(20);
  const orderId = await fx.createOrder(1);
  await fx.addProduct(orderId, storeItemId, 2);
  await fx.startAsaasPix(orderId, PAST);
  const { data: payment } = await fx.service.from('payments').select('id').eq('order_id', orderId).single();

  await fx.must(fx.service.rpc('_apply_terminal_order_payment_status', { p_payment_id: payment.id, p_target_status: 'expired' }), 'apply 1');
  assert.equal((await fx.storeInventoryOf(storeItemId)).reserved_quantity, 0, 'primeira chamada deve liberar a reserva');

  // Chamada direta da funcao "privada" (service_role) simula exatamente o
  // retry que a idempotencia precisa proteger -- os callers reais
  // (expire_stale_order_payments/apply_gateway_payment_status) ja evitam
  // reprocessar o mesmo payment, mas a funcao precisa ser segura por si so.
  await fx.must(fx.service.rpc('_apply_terminal_order_payment_status', { p_payment_id: payment.id, p_target_status: 'expired' }), 'apply 2 (retry)');
  const afterRetry = await fx.storeInventoryOf(storeItemId);
  assert.equal(afterRetry.reserved_quantity, 0, 'retry nao pode liberar de novo (ficaria negativo sem o clamp, ou vazaria pra outro pedido)');
});

test('release_store_item_reservation nunca deixa reserved_quantity negativa mesmo pedindo mais do que o reservado', async () => {
  const storeItemId = await fx.createStoreItem(20);
  await fx.must(fx.service.rpc('release_store_item_reservation', { p_store_item_id: storeItemId, p_variant_id: null, p_quantity: 999 }), 'release excessivo sem nunca ter reservado nada');
  const inv = await fx.storeInventoryOf(storeItemId);
  assert.equal(inv.reserved_quantity, 0, 'nunca deve ficar negativa');
});

test('cancelar pedido (refunded) libera a reserva do produto', async () => {
  const storeItemId = await fx.createStoreItem(20);
  const orderId = await fx.createOrder(1);
  await fx.addProduct(orderId, storeItemId, 4);
  const gatewayPaymentId = await fx.startAsaasPix(orderId, FUTURE);

  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'confirma pagamento');
  assert.equal((await fx.storeInventoryOf(storeItemId)).reserved_quantity, 4, 'reserva permanece apos confirmar pagamento (so libera na entrega fisica)');

  const { data: payment } = await fx.service.from('payments').select('id').eq('order_id', orderId).single();
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'REFUNDED', p_internal_status: 'refunded',
  }), 'estorna pagamento');
  void payment;

  const inv = await fx.storeInventoryOf(storeItemId);
  assert.equal(inv.reserved_quantity, 0, 'estorno deve liberar a reserva do produto ainda nao entregue');
  const { data: order } = await fx.service.from('orders').select('status').eq('id', orderId).single();
  assert.equal(order.status, 'refunded');
});

test('confirmar pagamento normalmente NAO libera a reserva do produto por acidente', async () => {
  const storeItemId = await fx.createStoreItem(20);
  const orderId = await fx.createOrder(1);
  await fx.addProduct(orderId, storeItemId, 3);
  const gatewayPaymentId = await fx.startAsaasPix(orderId, FUTURE);

  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'confirma pagamento');

  const inv = await fx.storeInventoryOf(storeItemId);
  assert.equal(inv.reserved_quantity, 3, 'confirmar pagamento e um evento comercial, nunca de estoque -- reserva so muda na entrega fisica ou num cancelamento/expiracao');
});

test('produto ja entregue nao sofre liberacao indevida quando o pagamento e estornado depois', async () => {
  const storeItemId = await fx.createStoreItem(20);
  const orderId = await fx.createOrder(1);
  const itemId = await fx.addProduct(orderId, storeItemId, 2);
  const gatewayPaymentId = await fx.startAsaasPix(orderId, FUTURE);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'confirma pagamento');

  // Simula a entrega fisica (deliver_store_item_stock move reserved->delivered).
  await fx.must(fx.service.rpc('deliver_store_item_stock', { p_store_item_id: storeItemId, p_variant_id: null, p_quantity: 2 }), 'entrega fisica');
  await fx.must(fx.service.from('order_items').update({ status: 'delivered', delivered_at: new Date().toISOString() }).eq('id', itemId), 'marca item como entregue');

  const beforeRefund = await fx.storeInventoryOf(storeItemId);
  assert.equal(beforeRefund.reserved_quantity, 0);
  assert.equal(beforeRefund.delivered_quantity, 2);

  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'REFUNDED', p_internal_status: 'refunded',
  }), 'estorna pagamento apos entrega');

  const afterRefund = await fx.storeInventoryOf(storeItemId);
  assert.equal(afterRefund.reserved_quantity, 0, 'nao pode ficar negativa nem mexer na reserva de outras unidades do mesmo produto');
  assert.equal(afterRefund.delivered_quantity, 2, 'quantidade entregue e um fato fisico -- estorno nao desfaz a entrega');

  const { data: item } = await fx.service.from('order_items').select('status').eq('id', itemId).single();
  assert.equal(item.status, 'delivered', 'item ja entregue deve permanecer delivered, nunca virar refunded silenciosamente');
});

// ============================================================
// reconcile_store_item_inventory_reservation (20260927000000) -- limpeza
// pontual do residuo ja acumulado ANTES da correcao de 20260926000000
// existir. Cenario reproduzido aqui: order_item marcado 'expired' via
// UPDATE direto (service_role), SEM passar por release_store_item_
// reservation -- exatamente o estado que o bug historico deixava (a
// correcao de 20260926 so previne casos NOVOS; nao reescreve o passado).
// ============================================================

test('reconciliacao: 2 reservas legitimas + 2 orfas (simulando o bug ja corrigido) -- sobra so a legitima, sem alterar pedidos', async () => {
  const storeItemId = await fx.createStoreItem(20);
  const legitOrderA = await fx.createProductOnlyOrder();
  await fx.addProduct(legitOrderA, storeItemId, 1);
  const legitOrderB = await fx.createProductOnlyOrder();
  await fx.addProduct(legitOrderB, storeItemId, 1);

  const orphanOrderA = await fx.createProductOnlyOrder();
  const orphanItemA = await fx.addProduct(orphanOrderA, storeItemId, 1);
  const orphanOrderB = await fx.createProductOnlyOrder();
  const orphanItemB = await fx.addProduct(orphanOrderB, storeItemId, 1);
  await fx.must(fx.service.from('order_items').update({ status: 'expired' }).in('id', [orphanItemA, orphanItemB]), 'simula orfaos (estado pre-20260926)');

  const before = await fx.storeInventoryOf(storeItemId);
  assert.equal(before.reserved_quantity, 4, 'estado inflado: 2 legitimas + 2 orfas');

  const result = await fx.must(fx.service.rpc('reconcile_store_item_inventory_reservation', { p_store_item_id: storeItemId, p_variant_id: null }), 'reconcile');
  const row = Array.isArray(result) ? result[0] : result;
  assert.equal(row.previous_reserved, 4);
  assert.equal(row.corrected_reserved, 2);
  assert.equal(row.delivered_quantity, 0);

  const after = await fx.storeInventoryOf(storeItemId);
  assert.equal(after.reserved_quantity, 2, 'so as 2 reservas legitimas devem sobrar');

  // Nunca toca pedidos/order_items -- os 2 itens continuam exatamente 'expired'.
  const orphans = await fx.must(fx.service.from('order_items').select('status').in('id', [orphanItemA, orphanItemB]), 'orfaos depois');
  assert.ok(orphans.every((o) => o.status === 'expired'));
});

test('reconciliacao rodada 2x: segunda chamada e no-op (idempotente)', async () => {
  const storeItemId = await fx.createStoreItem(20);
  const legitOrder = await fx.createProductOnlyOrder();
  await fx.addProduct(legitOrder, storeItemId, 1);
  const orphanOrder = await fx.createProductOnlyOrder();
  const orphanItem = await fx.addProduct(orphanOrder, storeItemId, 2);
  await fx.must(fx.service.from('order_items').update({ status: 'cancelled' }).eq('id', orphanItem), 'simula orfao via cancelamento');

  const first = await fx.must(fx.service.rpc('reconcile_store_item_inventory_reservation', { p_store_item_id: storeItemId, p_variant_id: null }), 'reconcile 1');
  const firstRow = Array.isArray(first) ? first[0] : first;
  assert.equal(firstRow.corrected_reserved, 1);

  const second = await fx.must(fx.service.rpc('reconcile_store_item_inventory_reservation', { p_store_item_id: storeItemId, p_variant_id: null }), 'reconcile 2 (retry)');
  const secondRow = Array.isArray(second) ? second[0] : second;
  assert.equal(secondRow.previous_reserved, 1, 'segunda chamada deve ver o valor ja corrigido como ponto de partida');
  assert.equal(secondRow.corrected_reserved, 1, 'nao deve mudar de novo');

  const after = await fx.storeInventoryOf(storeItemId);
  assert.equal(after.reserved_quantity, 1);
});

test('reconciliacao sem nenhum orfao nao altera nada', async () => {
  const storeItemId = await fx.createStoreItem(20);
  const orderId = await fx.createProductOnlyOrder();
  await fx.addProduct(orderId, storeItemId, 3);

  const before = await fx.storeInventoryOf(storeItemId);
  const result = await fx.must(fx.service.rpc('reconcile_store_item_inventory_reservation', { p_store_item_id: storeItemId, p_variant_id: null }), 'reconcile sem orfao');
  const row = Array.isArray(result) ? result[0] : result;
  assert.equal(row.previous_reserved, 3);
  assert.equal(row.corrected_reserved, 3, 'reserva 100% legitima nao pode ser alterada');

  const after = await fx.storeInventoryOf(storeItemId);
  assert.deepEqual(after, before, 'nenhum campo da linha de estoque deve mudar quando nao ha excesso');
});

test('reconciliacao nunca toca delivered_quantity, mesmo com entrega parcial no meio de orfaos', async () => {
  const storeItemId = await fx.createStoreItem(20);
  const deliveredOrder = await fx.createProductOnlyOrder();
  const deliveredItem = await fx.addProduct(deliveredOrder, storeItemId, 2);
  const gatewayPaymentId = await fx.startAsaasPix(deliveredOrder, FUTURE);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', { p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid' }), 'paga');
  await fx.must(fx.service.rpc('deliver_store_item_stock', { p_store_item_id: storeItemId, p_variant_id: null, p_quantity: 2 }), 'entrega fisica');
  await fx.must(fx.service.from('order_items').update({ status: 'delivered', delivered_at: new Date().toISOString() }).eq('id', deliveredItem), 'marca entregue');

  const orphanOrder = await fx.createProductOnlyOrder();
  const orphanItem = await fx.addProduct(orphanOrder, storeItemId, 5);
  await fx.must(fx.service.from('order_items').update({ status: 'refunded' }).eq('id', orphanItem), 'simula orfao via estorno');

  const before = await fx.storeInventoryOf(storeItemId);
  assert.equal(before.delivered_quantity, 2);
  assert.equal(before.reserved_quantity, 5, 'orfao de 5 unidades, nenhuma reserva legitima restante');

  await fx.must(fx.service.rpc('reconcile_store_item_inventory_reservation', { p_store_item_id: storeItemId, p_variant_id: null }), 'reconcile');

  const after = await fx.storeInventoryOf(storeItemId);
  assert.equal(after.reserved_quantity, 0, 'orfao inteiro deve ser removido (nenhuma reserva legitima)');
  assert.equal(after.delivered_quantity, 2, 'delivered_quantity nunca deve mudar');
  assert.equal(after.total_quantity, before.total_quantity, 'total_quantity (estoque fisico) nunca deve mudar');
});

test('reconciliacao considera reserva da loja standalone (store_order_items) na soma legitima -- pedido misto entre os dois dominios', async () => {
  const storeItemId = await fx.createStoreItem(20);
  const checkoutOrder = await fx.createProductOnlyOrder();
  await fx.addProduct(checkoutOrder, storeItemId, 2);
  const standaloneItemId = await fx.createStandaloneStoreOrderItem(storeItemId, 3, 'reserved');
  void standaloneItemId;
  // store_order_items inserido direto (sem passar por create_store_order)
  // nao bate reserved_quantity sozinho -- simula manualmente o estado real
  // (2 do checkout via RPC + 3 da loja) antes de inflar com o orfao.
  await fx.must(fx.service.from('store_item_inventory').update({ reserved_quantity: 2 + 3 }).eq('store_item_id', storeItemId).is('variant_id', null), 'ajusta reserva combinada dos 2 dominios');

  const orphanOrder = await fx.createProductOnlyOrder();
  const orphanItem = await fx.addProduct(orphanOrder, storeItemId, 4);
  await fx.must(fx.service.from('order_items').update({ status: 'expired' }).eq('id', orphanItem), 'simula orfao');
  await fx.must(fx.service.from('store_item_inventory').update({ reserved_quantity: 2 + 3 + 4 }).eq('store_item_id', storeItemId).is('variant_id', null), 'inflaciona com o orfao (estado pre-fix)');

  const result = await fx.must(fx.service.rpc('reconcile_store_item_inventory_reservation', { p_store_item_id: storeItemId, p_variant_id: null }), 'reconcile misto');
  const row = Array.isArray(result) ? result[0] : result;
  assert.equal(row.previous_reserved, 9);
  assert.equal(row.corrected_reserved, 5, '2 (checkout) + 3 (loja standalone) = 5 legitimas, 4 orfas removidas');
});

test('reconciliacao levanta excecao (nunca infla silenciosamente) quando a soma legitima e MAIOR que reserved_quantity atual', async () => {
  const storeItemId = await fx.createStoreItem(20);
  const orderId = await fx.createProductOnlyOrder();
  await fx.addProduct(orderId, storeItemId, 3);
  // Corrompe deliberadamente pra menos do que a soma legitima -- cenario que
  // NUNCA deveria acontecer; a funcao precisa abortar, nunca "consertar"
  // aumentando a reserva sozinha.
  await fx.must(fx.service.from('store_item_inventory').update({ reserved_quantity: 1 }).eq('store_item_id', storeItemId).is('variant_id', null), 'corrompe pra menos que o legitimo');

  const result = await fx.service.rpc('reconcile_store_item_inventory_reservation', { p_store_item_id: storeItemId, p_variant_id: null });
  assert.notEqual(result.error, null, 'deve falhar em vez de aumentar reserved_quantity silenciosamente');
});

test('reconciliacao nunca toca event_kit_item_variant_inventory -- item vinculado a kit nao tem linha em store_item_inventory e a funcao falha explicitamente', async () => {
  const linked = await fx.createLinkedStoreItem(20);
  const result = await fx.service.rpc('reconcile_store_item_inventory_reservation', { p_store_item_id: linked.storeItemId, p_variant_id: linked.variantId });
  assert.notEqual(result.error, null, 'item vinculado a kit nunca tem linha em store_item_inventory -- a funcao deve falhar, nunca criar uma');
  const kitInv = await fx.kitInventoryOf(linked.kitItemId, linked.kitVariantId);
  assert.equal(kitInv.reserved_quantity, 0, 'estoque do kit deve permanecer intocado');
});

test('remover produto do carrinho libera a reserva mesmo quando o produto e vinculado ao estoque do kit do evento', async () => {
  const linked = await fx.createLinkedStoreItem(20);
  const orderId = await fx.createProductOnlyOrder();
  const itemId = await fx.addProduct(orderId, linked.storeItemId, 3, linked.variantId);

  const before = await fx.kitInventoryOf(linked.kitItemId, linked.kitVariantId);
  assert.equal(before.reserved_quantity, 3, 'reserva deve rotear para o estoque do kit do evento, nunca store_item_inventory');

  const removeResult = await fx.buyer.rpc('remove_cart_order_item', { p_order_item_id: itemId });
  assert.equal(removeResult.error, null, removeResult.error?.message);

  const after = await fx.kitInventoryOf(linked.kitItemId, linked.kitVariantId);
  assert.equal(after.reserved_quantity, 0, 'remover do carrinho deve liberar a reserva do estoque do kit tambem para item vinculado');
});
