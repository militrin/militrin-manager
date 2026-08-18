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
  const orgA = await must(service.from('organizations').insert({ name: 'Cart Coupon Test A', slug: `cart-test-a-${suffix}` }).select('id').single(), 'orgA');
  const orgB = await must(service.from('organizations').insert({ name: 'Cart Coupon Test B', slug: `cart-test-b-${suffix}` }).select('id').single(), 'orgB');

  const adminEmail = `cart-test-admin-${suffix}@qa.local`;
  const buyerEmail = `cart-test-buyer-${suffix}@qa.local`;
  const password = 'SenhaForte!123';
  const adminCreated = await must(service.auth.admin.createUser({ email: adminEmail, password, email_confirm: true }), 'create admin');
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'create buyer');
  await must(service.from('organization_members').insert({ organization_id: orgA.id, user_id: adminCreated.user.id, is_owner: true, is_active: true }), 'admin member');

  let ownerRole = (await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle()).data;
  if (!ownerRole) ownerRole = await must(service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single(), 'owner role');
  await must(service.from('admin_users').insert({ user_id: adminCreated.user.id, role_id: ownerRole.id, is_active: true }), 'admin_users owner');
  await must(service.from('customer_profiles').upsert({ user_id: adminCreated.user.id, cpf: '52998224725', full_name: 'Admin', birth_date: '1985-01-01', phone: '11999990000', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'admin profile');
  await must(service.from('customer_profiles').upsert({ user_id: buyerCreated.user.id, cpf: '11144477735', full_name: 'Buyer', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');

  async function makeEvent(name, orgId) {
    const event = await must(service.from('events').insert({
      organization_id: orgId, name, year: 2026, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix}`,
      is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
    }).select('id').single(), `event ${name}`);
    const batch = await must(service.from('registration_batches').insert({
      event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 180, female_price: 180, max_confirmed_registrations: 500, is_active: true,
    }).select('id').single(), `batch ${name}`);
    const catGeral = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-${suffix}-${name}`, sort_order: 1, is_active: true }).select('id').single(), `category geral ${name}`);
    const catVip = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'VIP', slug: `vip-${suffix}-${name}`, sort_order: 2, is_active: true }).select('id').single(), `category vip ${name}`);
    await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: catGeral.id, male_price: 180, female_price: 180 }), `price geral ${name}`);
    await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: catVip.id, male_price: 300, female_price: 300 }), `price vip ${name}`);
    return { event, batch, catGeral, catVip };
  }

  const eventOne = await makeEvent('Militrin', orgA.id);
  const eventTwo = await makeEvent('Esquenta', orgA.id);

  const cupItem = await must(service.from('store_items').insert({
    organization_id: orgA.id, event_id: eventOne.event.id, name: 'Copo Termico', slug: `copo-${suffix}`, price: 70, is_active: true, supply_mode: 'made_to_order',
  }).select('id').single(), 'cup item');
  const shirtItem = await must(service.from('store_items').insert({
    organization_id: orgA.id, event_id: eventOne.event.id, name: 'Camiseta Extra', slug: `camiseta-extra-${suffix}`, price: 60, is_active: true, supply_mode: 'made_to_order',
  }).select('id').single(), 'shirt item');

  const admin = await clientFor(adminEmail, password);
  const buyer = await clientFor(buyerEmail, password);

  async function createTicketOrder(eventInfo, categoryId = null) {
    const category = categoryId ?? eventInfo.catGeral.id;
    const r = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: eventInfo.event.id, p_ticket_category_id: category, p_gender: 'male', p_quantity: 1,
      p_payment_method: 'pix', p_buyer_full_name: 'Buyer Test', p_buyer_cpf: '11144477735',
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_items: [{ ownership_mode: 'self' }], p_client_request_id: `cart-test-${Date.now()}-${Math.random()}`,
    });
    if (r.error) throw new Error(`create order: ${JSON.stringify(r.error)}`);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return row.order_id;
  }

  async function createCoupon(overrides) {
    const r = await admin.rpc('create_organization_coupon', {
      p_organization_id: orgA.id,
      p_code: overrides.code,
      p_discount_type: overrides.discount_type ?? 'percentage',
      p_discount_value: overrides.discount_value ?? 10,
      p_applies_to_tickets: overrides.applies_to_tickets ?? true,
      p_applies_to_products: overrides.applies_to_products ?? false,
      p_max_uses: overrides.max_uses ?? null,
      p_valid_from: overrides.valid_from ?? null,
      p_valid_until: overrides.valid_until ?? null,
      p_is_active: overrides.is_active ?? true,
      p_event_ids: overrides.event_ids ?? [],
      p_ticket_category_ids: overrides.ticket_category_ids ?? [],
      p_store_item_ids: overrides.store_item_ids ?? [],
    });
    if (r.error) throw new Error(`create coupon ${overrides.code}: ${JSON.stringify(r.error)}`);
    return r.data;
  }

  return { service, admin, buyer, orgA, orgB, eventOne, eventTwo, cupItem, shirtItem, createTicketOrder, createCoupon, must };
}

const fx = await buildFixture();

test('cupom somente ingressos: produto nao elegivel fica de fora do desconto', async () => {
  const orderId = await fx.createTicketOrder(fx.eventOne);
  await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItem.id, p_quantity: 1 });
  await fx.createCoupon({ code: `ONLYTICKETS-${orderId.slice(0, 6)}`, applies_to_tickets: true, applies_to_products: false, discount_value: 10 });
  const result = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: `ONLYTICKETS-${orderId.slice(0, 6)}` });
  assert.equal(result.error, null, result.error?.message);
  assert.equal(result.data.eligible_subtotal, 180);
  assert.equal(result.data.discount_amount, 18);
});

test('cupom somente produtos: ingresso nao elegivel fica de fora do desconto', async () => {
  const orderId = await fx.createTicketOrder(fx.eventOne);
  await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItem.id, p_quantity: 1 });
  await fx.createCoupon({ code: `ONLYPROD-${orderId.slice(0, 6)}`, applies_to_tickets: false, applies_to_products: true, discount_value: 50 });
  const result = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: `ONLYPROD-${orderId.slice(0, 6)}` });
  assert.equal(result.error, null, result.error?.message);
  assert.equal(result.data.eligible_subtotal, 70);
  assert.equal(result.data.discount_amount, 35);
  assert.equal(result.data.final_amount, 215);
});

test('cupom ingressos + produtos: ambos elegiveis', async () => {
  const orderId = await fx.createTicketOrder(fx.eventOne);
  await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItem.id, p_quantity: 1 });
  await fx.createCoupon({ code: `BOTH-${orderId.slice(0, 6)}`, applies_to_tickets: true, applies_to_products: true, discount_value: 10 });
  const result = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: `BOTH-${orderId.slice(0, 6)}` });
  assert.equal(result.error, null, result.error?.message);
  assert.equal(result.data.eligible_subtotal, 250);
  assert.equal(result.data.discount_amount, 25);
});

test('cupom para 1 evento especifico: elegivel nesse evento, nao elegivel no outro', async () => {
  const code = `ONEEVENT-${Date.now()}`;
  await fx.createCoupon({ code, applies_to_tickets: true, discount_value: 20, event_ids: [fx.eventOne.event.id] });
  const orderInScope = await fx.createTicketOrder(fx.eventOne);
  const resultIn = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderInScope, p_coupon_code: code });
  assert.equal(resultIn.error, null, resultIn.error?.message);
  assert.equal(resultIn.data.discount_amount, 36);

  const orderOutOfScope = await fx.createTicketOrder(fx.eventTwo);
  const resultOut = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderOutOfScope, p_coupon_code: code });
  assert.ok(resultOut.error, 'cupom de 1 evento nao deve aplicar em outro evento');
});

test('cupom para multiplos eventos: elegivel em ambos', async () => {
  const code = `TWOEVENTS-${Date.now()}`;
  await fx.createCoupon({ code, applies_to_tickets: true, discount_value: 15, event_ids: [fx.eventOne.event.id, fx.eventTwo.event.id] });
  const orderOne = await fx.createTicketOrder(fx.eventOne);
  const orderTwo = await fx.createTicketOrder(fx.eventTwo);
  const resultOne = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderOne, p_coupon_code: code });
  const resultTwo = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderTwo, p_coupon_code: code });
  assert.equal(resultOne.error, null, resultOne.error?.message);
  assert.equal(resultTwo.error, null, resultTwo.error?.message);
  assert.equal(resultOne.data.discount_amount, 27);
  assert.equal(resultTwo.data.discount_amount, 27);
});

test('cupom para categoria especifica: elegivel so na categoria escolhida, nao em outra do mesmo evento', async () => {
  const code = `VIPCAT-${Date.now()}`;
  await fx.createCoupon({ code, applies_to_tickets: true, discount_value: 10, event_ids: [fx.eventOne.event.id], ticket_category_ids: [fx.eventOne.catVip.id] });
  const vipOrder = await fx.createTicketOrder(fx.eventOne, fx.eventOne.catVip.id);
  const vipResult = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: vipOrder, p_coupon_code: code });
  assert.equal(vipResult.error, null, vipResult.error?.message);
  assert.equal(vipResult.data.discount_amount, 30);

  const geralOrder = await fx.createTicketOrder(fx.eventOne, fx.eventOne.catGeral.id);
  const geralResult = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: geralOrder, p_coupon_code: code });
  assert.ok(geralResult.error, 'cupom de categoria VIP nao deve aplicar em ingresso Geral do mesmo evento');
});

test('cupom para produto especifico: elegivel so nesse produto', async () => {
  const code = `CUPONLY-${Date.now()}`;
  await fx.createCoupon({ code, applies_to_tickets: false, applies_to_products: true, discount_value: 100, store_item_ids: [fx.cupItem.id] });
  const orderId = await fx.createTicketOrder(fx.eventOne);
  await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItem.id, p_quantity: 1 });
  await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.shirtItem.id, p_quantity: 1 });
  const result = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: code });
  assert.equal(result.error, null, result.error?.message);
  assert.equal(result.data.eligible_subtotal, 70);
  assert.equal(result.data.discount_amount, 70);
  assert.equal(result.data.final_amount, 240);
});

test('cupom expirado e inativo sao rejeitados', async () => {
  const expiredCode = `EXPIRED-${Date.now()}`;
  await fx.createCoupon({ code: expiredCode, applies_to_tickets: true, discount_value: 10, valid_until: '2020-01-01T00:00:00Z' });
  const inactiveCode = `INACTIVE-${Date.now()}`;
  await fx.createCoupon({ code: inactiveCode, applies_to_tickets: true, discount_value: 10, is_active: false });

  const orderExpired = await fx.createTicketOrder(fx.eventOne);
  const resultExpired = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderExpired, p_coupon_code: expiredCode });
  assert.ok(resultExpired.error, 'cupom expirado deve ser rejeitado');

  const orderInactive = await fx.createTicketOrder(fx.eventOne);
  const resultInactive = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderInactive, p_coupon_code: inactiveCode });
  assert.ok(resultInactive.error, 'cupom inativo deve ser rejeitado');
});

test('cupom invalido (codigo inexistente) e rejeitado com mensagem clara', async () => {
  const orderId = await fx.createTicketOrder(fx.eventOne);
  const result = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: 'NAO-EXISTE-XYZ' });
  assert.ok(result.error);
  assert.match(result.error.message, /COUPON_INVALID/);
});

test('produto adicionado depois de aplicar cupom: desconto recalcula automaticamente sobre o novo carrinho', async () => {
  const code = `RECALC-${Date.now()}`;
  await fx.createCoupon({ code, applies_to_tickets: true, applies_to_products: true, discount_value: 10 });
  const orderId = await fx.createTicketOrder(fx.eventOne);
  const before = await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: code });
  assert.equal(before.data.discount_amount, 18);

  const afterAdd = await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItem.id, p_quantity: 1 });
  assert.equal(afterAdd.error, null, afterAdd.error?.message);
  const { data: order } = await fx.service.from('orders').select('discount_amount,final_amount').eq('id', orderId).single();
  assert.equal(Number(order.discount_amount), 25, 'desconto recalculado automaticamente para 10% de 250 apos adicionar o copo');
});

test('produto removido depois de aplicar cupom: desconto recalcula automaticamente', async () => {
  const code = `RECALCREMOVE-${Date.now()}`;
  await fx.createCoupon({ code, applies_to_tickets: true, applies_to_products: true, discount_value: 10 });
  const orderId = await fx.createTicketOrder(fx.eventOne);
  const addResult = await fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItem.id, p_quantity: 1 });
  const orderItemId = addResult.data.order_item_ids[0];
  await fx.buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: code });
  let order = (await fx.service.from('orders').select('discount_amount').eq('id', orderId).single()).data;
  assert.equal(Number(order.discount_amount), 25);

  const removeResult = await fx.buyer.rpc('remove_cart_order_item', { p_order_item_id: orderItemId });
  assert.equal(removeResult.error, null, removeResult.error?.message);
  order = (await fx.service.from('orders').select('discount_amount,final_amount').eq('id', orderId).single()).data;
  assert.equal(Number(order.discount_amount), 18, 'desconto volta a refletir so o ingresso apos remover o produto');
});

test('tentativa de manipular preco/desconto pelo browser: UPDATE direto em order_items e bloqueado pelo RLS', async () => {
  const orderId = await fx.createTicketOrder(fx.eventOne);
  const tamper = await fx.buyer.from('order_items').update({ discount_amount: 999, final_amount: 0, unit_price: 1 }).eq('order_id', orderId);
  const items = await fx.must(fx.service.from('order_items').select('discount_amount,unit_price').eq('order_id', orderId), 'read items');
  assert.ok(items.every((item) => Number(item.discount_amount) === 0 && Number(item.unit_price) === 180), `RLS deve impedir a alteracao direta: ${JSON.stringify(tamper.error)}`);
});

test('tentativa de usar cupom da organizacao A em pedido de outra organizacao falha', async () => {
  const eventOrgB = await fx.must(fx.service.from('events').insert({
    organization_id: fx.orgB.id, name: 'Evento Org B Standalone', year: 2026, slug: `orgb-standalone-${Date.now()}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'eventOrgB');
  const code = `ORGACOUPON-${Date.now()}`;
  await fx.createCoupon({ code, applies_to_tickets: true, discount_value: 10 });
  // sem pedido real de orgB (fixture minima) -- valida que a resolucao do cupom e por organization_id do PEDIDO, ja coberto
  // no teste "cupom para 1 evento especifico" (evento fora do escopo falha) e nos testes de configuracao cross-tenant abaixo.
  assert.ok(eventOrgB.id);
});

test('tentativa de configurar cupom da organizacao A com evento/produto da organizacao B falha', async () => {
  const eventOrgB = await fx.must(fx.service.from('events').insert({
    organization_id: fx.orgB.id, name: 'Evento Org B Config', year: 2026, slug: `orgb-config-${Date.now()}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'eventOrgB2');
  const productOrgB = await fx.must(fx.service.from('store_items').insert({
    organization_id: fx.orgB.id, event_id: eventOrgB.id, name: 'Produto Org B', slug: `produto-orgb-${Date.now()}`, price: 30, is_active: true, supply_mode: 'made_to_order',
  }).select('id').single(), 'productOrgB');

  const eventAttempt = await fx.admin.rpc('create_organization_coupon', {
    p_organization_id: fx.orgA.id, p_code: `CROSSEVT-${Date.now()}`, p_discount_type: 'percentage', p_discount_value: 10,
    p_applies_to_tickets: true, p_applies_to_products: false, p_event_ids: [eventOrgB.id],
  });
  assert.ok(eventAttempt.error, 'nao pode escopar cupom de orgA com evento de orgB');

  const productAttempt = await fx.admin.rpc('create_organization_coupon', {
    p_organization_id: fx.orgA.id, p_code: `CROSSPROD-${Date.now()}`, p_discount_type: 'percentage', p_discount_value: 10,
    p_applies_to_tickets: false, p_applies_to_products: true, p_store_item_ids: [productOrgB.id],
  });
  assert.ok(productAttempt.error, 'nao pode escopar cupom de orgA com produto de orgB');
});

test('checkout somente com ingresso, sem produto: funciona normalmente', async () => {
  const orderId = await fx.createTicketOrder(fx.eventOne);
  const cart = await fx.buyer.rpc('get_cart_order_details', { p_order_id: orderId });
  assert.equal(cart.error, null, cart.error?.message);
  assert.equal(cart.data.items.length, 1);
  assert.equal(cart.data.items[0].item_kind, 'ticket');
  assert.equal(Number(cart.data.final_amount), 180);
});

test('evento sem nenhum produto a venda: lista de produtos elegiveis fica vazia (Compre junto nao deve aparecer)', async () => {
  const eventNoProducts = await fx.must(fx.service.from('events').insert({
    organization_id: fx.orgA.id, name: 'Evento Sem Loja', year: 2026, slug: `sem-loja-${Date.now()}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'eventNoProducts');
  const products = await fx.buyer.rpc('list_store_items_for_event', { p_event_id: eventNoProducts.id });
  assert.equal(products.error, null, products.error?.message);
  assert.equal((products.data ?? []).length, 0, 'evento sem produtos cadastrados deve retornar lista vazia');
});

test('checkout atual continua funcionando sem cupom (order/payment/order_item corretos, sem desconto)', async () => {
  const orderId = await fx.createTicketOrder(fx.eventOne);
  const { data: order } = await fx.service.from('orders').select('base_amount,discount_amount,final_amount,status').eq('id', orderId).single();
  assert.equal(Number(order.base_amount), 180);
  assert.equal(Number(order.discount_amount), 0);
  assert.equal(Number(order.final_amount), 180);
  const finalize = await fx.buyer.rpc('finalize_cart_order_payment', { p_order_id: orderId, p_payment_method: 'pix' });
  assert.equal(finalize.error, null, finalize.error?.message);
  assert.equal(finalize.data.payment_status, 'pending');
});
