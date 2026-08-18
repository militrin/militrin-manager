import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

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
  const org = await must(service.from('organizations').insert({ name: `Cart Qty Org ${suffix}`, slug: `cart-qty-org-${suffix}` }).select('id').single(), 'org');

  const password = 'SenhaForte!123';
  let ownerRole = (await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle()).data;
  if (!ownerRole) ownerRole = await must(service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single(), 'owner role');

  const adminEmail = `cart-qty-admin-${suffix}@qa.local`;
  const buyerEmail = `cart-qty-buyer-${suffix}@qa.local`;
  const adminCreated = await must(service.auth.admin.createUser({ email: adminEmail, password, email_confirm: true }), 'create admin');
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'create buyer');
  await must(service.from('organization_members').insert({ organization_id: org.id, user_id: adminCreated.user.id, is_owner: true, is_active: true }), 'admin member');
  await must(service.from('admin_users').insert({ user_id: adminCreated.user.id, role_id: ownerRole.id, is_active: true }), 'admin_users owner');
  await must(service.from('customer_profiles').upsert({ user_id: adminCreated.user.id, cpf: '52998224725', full_name: 'Admin', birth_date: '1985-01-01', phone: '11999990000', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'admin profile');
  await must(service.from('customer_profiles').upsert({ user_id: buyerCreated.user.id, cpf: '11144477735', full_name: 'Buyer', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');

  const event = await must(service.from('events').insert({
    organization_id: org.id, name: `Cart Qty Evento ${suffix}`, year: 2026, slug: `cart-qty-evento-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 100, female_price: 100 }), 'price');

  const admin = await clientFor(adminEmail, password);
  const buyer = await clientFor(buyerEmail, password);

  // Copo: estoque limitado (10 un). Squeeze: por encomenda (sem limite).
  // Estoque bem folgado -- este item e reusado por varios testes de
  // consolidacao/desconto neste arquivo (nao isolado por teste), entao o
  // limite so precisa ser alto o bastante pra nunca interferir com a
  // asserção de nenhum desses testes. Os testes que verificam o limite de
  // estoque de verdade usam createLimitedStockItem, com item proprio.
  const cupItemId = await must(admin.rpc('upsert_store_item', {
    p_id: null, p_event_id: event.id, p_name: `Copo Qty ${suffix}`, p_slug: `copo-qty-${suffix}`,
    p_description: null, p_price: 60, p_requires_variant: false, p_is_active: true, p_sort_order: 0,
    p_supply_mode: 'stock', p_available_all_events: false,
  }), 'create cup item');
  await must(service.from('store_item_inventory').insert({ store_item_id: cupItemId, variant_id: null, total_quantity: 1000, reserved_quantity: 0, delivered_quantity: 0 }), 'cup inventory');

  async function createLimitedStockItem(totalQuantity) {
    const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const id = await must(admin.rpc('upsert_store_item', {
      p_id: null, p_event_id: event.id, p_name: `Limitado ${uniqueSuffix}`, p_slug: `limitado-${uniqueSuffix}`,
      p_description: null, p_price: 60, p_requires_variant: false, p_is_active: true, p_sort_order: 0,
      p_supply_mode: 'stock', p_available_all_events: false,
    }), 'create limited item');
    await must(service.from('store_item_inventory').insert({ store_item_id: id, variant_id: null, total_quantity: totalQuantity, reserved_quantity: 0, delivered_quantity: 0 }), 'limited item inventory');
    return id;
  }

  const squeezeItemId = await must(admin.rpc('upsert_store_item', {
    p_id: null, p_event_id: event.id, p_name: `Squeeze Qty ${suffix}`, p_slug: `squeeze-qty-${suffix}`,
    p_description: null, p_price: 40, p_requires_variant: false, p_is_active: true, p_sort_order: 0,
    p_supply_mode: 'made_to_order', p_available_all_events: false,
  }), 'create squeeze item');

  const shirtItemId = await must(admin.rpc('upsert_store_item', {
    p_id: null, p_event_id: event.id, p_name: `Camiseta Qty ${suffix}`, p_slug: `camiseta-qty-${suffix}`,
    p_description: null, p_price: 80, p_requires_variant: true, p_is_active: true, p_sort_order: 0,
    p_supply_mode: 'stock', p_available_all_events: false,
  }), 'create shirt item');
  const variantM = await must(admin.rpc('upsert_store_item_variant', { p_id: null, p_store_item_id: shirtItemId, p_name: 'Tamanho', p_value: 'M', p_price_adjustment: 0, p_is_active: true, p_sort_order: 0 }), 'variant M');
  const variantG = await must(admin.rpc('upsert_store_item_variant', { p_id: null, p_store_item_id: shirtItemId, p_name: 'Tamanho', p_value: 'G', p_price_adjustment: 5, p_is_active: true, p_sort_order: 1 }), 'variant G');
  await must(service.from('store_item_inventory').insert({ store_item_id: shirtItemId, variant_id: variantM, total_quantity: 3, reserved_quantity: 0, delivered_quantity: 0 }), 'shirt M inventory');
  await must(service.from('store_item_inventory').insert({ store_item_id: shirtItemId, variant_id: variantG, total_quantity: 5, reserved_quantity: 0, delivered_quantity: 0 }), 'shirt G inventory');

  async function createTicketOrder() {
    const r = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: category.id, p_gender: 'male', p_quantity: 1,
      p_payment_method: 'pix', p_buyer_full_name: 'Buyer', p_buyer_cpf: '11144477735',
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_items: [{ ownership_mode: 'self' }], p_client_request_id: `cart-qty-${Date.now()}-${Math.random()}`,
    });
    if (r.error) throw new Error(`create order: ${JSON.stringify(r.error)}`);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return row.order_id;
  }

  async function cartDetails(orderId) {
    const { data, error } = await buyer.rpc('get_cart_order_details', { p_order_id: orderId });
    if (error) throw new Error(`cart details: ${JSON.stringify(error)}`);
    return data;
  }

  async function createCoupon(overrides) {
    const r = await admin.rpc('create_organization_coupon', {
      p_organization_id: org.id, p_code: overrides.code, p_discount_type: overrides.discount_type ?? 'percentage',
      p_discount_value: overrides.discount_value ?? 10, p_applies_to_tickets: overrides.applies_to_tickets ?? false,
      p_applies_to_products: overrides.applies_to_products ?? true, p_max_uses: null, p_valid_from: null, p_valid_until: null,
      p_notes: null, p_is_active: true, p_event_ids: [], p_ticket_category_ids: [], p_store_item_ids: overrides.store_item_ids ?? [],
    });
    if (r.error) throw new Error(`create coupon ${overrides.code}: ${JSON.stringify(r.error)}`);
    return r.data;
  }

  return { service, admin, buyer, org, event, cupItemId, squeezeItemId, shirtItemId, variantM, variantG, createTicketOrder, cartDetails, createCoupon, createLimitedStockItem, must };
}

const fx = await buildFixture();

test('adicionar quantidade 1: cria 1 linha com quantity=1', async () => {
  const orderId = await fx.createTicketOrder();
  const result = await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1 });
  assert.equal(result.error, null, result.error?.message);

  const cart = await fx.cartDetails(orderId);
  const line = cart.items.find((i) => i.store_item_id === fx.cupItemId);
  assert.equal(line.quantity, 1);
  assert.equal(Number(line.final_amount), 60);
});

test('adicionar quantidade 2 de uma vez: 1 linha consolidada com quantity=2', async () => {
  const orderId = await fx.createTicketOrder();
  const result = await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 2 });
  assert.equal(result.error, null, result.error?.message);
  assert.equal(result.data.order_item_ids.length, 1, 'deve retornar 1 unico order_item_id, nao 2 linhas');

  const cart = await fx.cartDetails(orderId);
  const lines = cart.items.filter((i) => i.store_item_id === fx.cupItemId);
  assert.equal(lines.length, 1, 'deve existir apenas 1 linha para o produto');
  assert.equal(lines[0].quantity, 2);
  assert.equal(Number(lines[0].final_amount), 120);
});

test('adicionar 1 e depois adicionar de novo: consolida para quantity=2 na mesma linha', async () => {
  const orderId = await fx.createTicketOrder();
  const first = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1 }), 'add 1');
  const second = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1 }), 'add 1 de novo');
  assert.equal(first.order_item_ids[0], second.order_item_ids[0], 'segunda adicao deve reutilizar a mesma linha, nao criar outra');

  const cart = await fx.cartDetails(orderId);
  const lines = cart.items.filter((i) => i.store_item_id === fx.cupItemId);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 2);
});

test('aumentar e diminuir quantidade no carrinho recalcula subtotal da linha e do pedido', async () => {
  const orderId = await fx.createTicketOrder();
  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 2 }), 'add 2');
  const itemId = added.order_item_ids[0];

  const increase = await fx.buyer.rpc('set_cart_order_item_quantity', { p_order_item_id: itemId, p_quantity: 5 });
  assert.equal(increase.error, null, increase.error?.message);
  let cart = await fx.cartDetails(orderId);
  let line = cart.items.find((i) => i.order_item_id === itemId);
  assert.equal(line.quantity, 5);
  assert.equal(Number(line.final_amount), 300);
  assert.equal(Number(cart.final_amount), 400, 'pedido = 100 (ingresso) + 300 (5 copos)');

  const decrease = await fx.buyer.rpc('set_cart_order_item_quantity', { p_order_item_id: itemId, p_quantity: 1 });
  assert.equal(decrease.error, null, decrease.error?.message);
  cart = await fx.cartDetails(orderId);
  line = cart.items.find((i) => i.order_item_id === itemId);
  assert.equal(line.quantity, 1);
  assert.equal(Number(line.final_amount), 60);
  assert.equal(Number(cart.final_amount), 160);
});

test('remover linha libera a quantidade inteira reservada, nao so 1 unidade', async () => {
  const limitedItemId = await fx.createLimitedStockItem(20);
  const orderId = await fx.createTicketOrder();
  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: limitedItemId, p_quantity: 4 }), 'add 4');
  const itemId = added.order_item_ids[0];

  const before = await fx.must(fx.service.from('store_item_inventory').select('reserved_quantity').eq('store_item_id', limitedItemId).is('variant_id', null).single(), 'inv before');
  assert.equal(before.reserved_quantity, 4);

  const removeResult = await fx.buyer.rpc('remove_cart_order_item', { p_order_item_id: itemId });
  assert.equal(removeResult.error, null, removeResult.error?.message);

  const after = await fx.must(fx.service.from('store_item_inventory').select('reserved_quantity').eq('store_item_id', limitedItemId).is('variant_id', null).single(), 'inv after');
  assert.equal(after.reserved_quantity, 0, 'toda a quantidade da linha (4) deve ser liberada, nao so 1');

  const cart = await fx.cartDetails(orderId);
  assert.ok(!cart.items.some((i) => i.order_item_id === itemId), 'linha removida nao deve aparecer mais no carrinho');
});

test('dois produtos diferentes: linhas separadas, nunca consolidadas entre si', async () => {
  const orderId = await fx.createTicketOrder();
  await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1 }), 'add cup');
  await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.squeezeItemId, p_quantity: 1 }), 'add squeeze');

  const cart = await fx.cartDetails(orderId);
  const productLines = cart.items.filter((i) => i.item_kind === 'product');
  assert.equal(productLines.length, 2, 'produtos diferentes devem ficar em linhas separadas');
});

test('duas variantes diferentes do mesmo produto: linhas separadas, nunca consolidadas entre si', async () => {
  const orderId = await fx.createTicketOrder();
  const m = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.shirtItemId, p_variant_id: fx.variantM, p_quantity: 2 }), 'add M');
  const g = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.shirtItemId, p_variant_id: fx.variantG, p_quantity: 3 }), 'add G');
  assert.notEqual(m.order_item_ids[0], g.order_item_ids[0]);

  const cart = await fx.cartDetails(orderId);
  const shirtLines = cart.items.filter((i) => i.store_item_id === fx.shirtItemId);
  assert.equal(shirtLines.length, 2, 'variantes diferentes devem gerar linhas separadas');
  const lineM = shirtLines.find((i) => i.store_item_variant_id === fx.variantM);
  const lineG = shirtLines.find((i) => i.store_item_variant_id === fx.variantG);
  assert.equal(lineM.quantity, 2);
  assert.equal(Number(lineM.unit_price), 80);
  assert.equal(lineG.quantity, 3);
  assert.equal(Number(lineG.unit_price), 85, 'variante G tem price_adjustment de +5');

  // adicionar mais M nao deve afetar G
  await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.shirtItemId, p_variant_id: fx.variantM, p_quantity: 1 }), 'add mais M');
  const cart2 = await fx.cartDetails(orderId);
  const lines2 = cart2.items.filter((i) => i.store_item_id === fx.shirtItemId);
  assert.equal(lines2.length, 2);
  assert.equal(lines2.find((i) => i.store_item_variant_id === fx.variantM).quantity, 3);
  assert.equal(lines2.find((i) => i.store_item_variant_id === fx.variantG).quantity, 3, 'G nao deve ter mudado');
});

test('cupom sobre quantidade > 1: desconto calculado sobre o subtotal da linha inteira (3 x R$60, 20% = R$36)', async () => {
  const code = `QTYDISCOUNT-${Date.now()}`;
  await fx.createCoupon({ code, discount_type: 'percentage', discount_value: 20, store_item_ids: [fx.cupItemId] });
  const orderId = await fx.createTicketOrder();
  await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 3 }), 'add 3 copos');

  const result = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: code });
  assert.equal(result.error, null, result.error?.message);
  assert.equal(result.data.eligible_subtotal, 180);
  assert.equal(result.data.discount_amount, 36);

  const cart = await fx.cartDetails(orderId);
  const line = cart.items.find((i) => i.store_item_id === fx.cupItemId);
  assert.equal(Number(line.discount_amount), 36);
  assert.equal(Number(line.final_amount), 144);
});

test('quantidade manipulada pelo frontend: zero, negativo e decimal sao rejeitados pelo backend', async () => {
  const orderId = await fx.createTicketOrder();

  const zero = await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 0 });
  assert.ok(zero.error, 'quantidade 0 deve ser rejeitada');

  const negative = await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: -3 });
  assert.ok(negative.error, 'quantidade negativa deve ser rejeitada');

  const decimal = await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1.5 });
  assert.ok(decimal.error, 'quantidade decimal deve ser rejeitada pelo tipo integer da coluna/parametro');

  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1 }), 'add valido');
  const itemId = added.order_item_ids[0];
  const setZero = await fx.buyer.rpc('set_cart_order_item_quantity', { p_order_item_id: itemId, p_quantity: 0 });
  assert.ok(setZero.error, 'set_cart_order_item_quantity com 0 deve ser rejeitado (remocao e via remove_cart_order_item)');
  const setNegative = await fx.buyer.rpc('set_cart_order_item_quantity', { p_order_item_id: itemId, p_quantity: -1 });
  assert.ok(setNegative.error, 'set_cart_order_item_quantity negativo deve ser rejeitado');
});

test('limite de estoque: nao deixa reservar alem do disponivel, nem ao aumentar quantidade depois', async () => {
  const limitedItemId = await fx.createLimitedStockItem(10);
  const orderId = await fx.createTicketOrder();
  const tooMany = await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: limitedItemId, p_quantity: 11 });
  assert.ok(tooMany.error, 'pedir mais que o estoque total (10) deve ser rejeitado');

  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: limitedItemId, p_quantity: 8 }), 'add 8 de 10');
  const itemId = added.order_item_ids[0];

  const increaseBeyond = await fx.buyer.rpc('set_cart_order_item_quantity', { p_order_item_id: itemId, p_quantity: 11 });
  assert.ok(increaseBeyond.error, 'aumentar para alem do estoque disponivel deve ser rejeitado');

  const cart = await fx.cartDetails(orderId);
  const line = cart.items.find((i) => i.order_item_id === itemId);
  assert.equal(line.quantity, 8, 'quantidade deve permanecer inalterada apos tentativa rejeitada');
});

test('produto sem estoque (esgotado): nem 1 unidade pode ser adicionada', async () => {
  const limitedItemId = await fx.createLimitedStockItem(10);
  const orderId = await fx.createTicketOrder();
  await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: limitedItemId, p_quantity: 10 }), 'esgota estoque');

  const secondOrderId = await fx.createTicketOrder();
  const result = await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: secondOrderId, p_store_item_id: limitedItemId, p_quantity: 1 });
  assert.ok(result.error, 'produto esgotado nao deve aceitar nenhuma unidade');
  assert.match(result.error.message, /PRODUCT_OUT_OF_STOCK/);
});

test('produto sem limite (por encomenda): aceita quantidade alta sem checagem de estoque', async () => {
  const orderId = await fx.createTicketOrder();
  const result = await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.squeezeItemId, p_quantity: 500 });
  assert.equal(result.error, null, result.error?.message);

  const cart = await fx.cartDetails(orderId);
  const line = cart.items.find((i) => i.store_item_id === fx.squeezeItemId);
  assert.equal(line.quantity, 500);
});
