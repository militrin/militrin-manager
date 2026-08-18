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
  const org = await must(service.from('organizations').insert({ name: `Snapshot Org ${suffix}`, slug: `snapshot-org-${suffix}` }).select('id').single(), 'org');

  let ownerRole = (await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle()).data;
  if (!ownerRole) ownerRole = await must(service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single(), 'owner role');

  const adminEmail = `snapshot-admin-${suffix}@qa.local`;
  const adminCreated = await must(service.auth.admin.createUser({ email: adminEmail, password, email_confirm: true }), 'create admin');
  await must(service.from('organization_members').insert({ organization_id: org.id, user_id: adminCreated.user.id, is_owner: true, is_active: true }), 'admin member');
  await must(service.from('admin_users').insert({ user_id: adminCreated.user.id, role_id: ownerRole.id, is_active: true }), 'admin_users owner');
  await must(service.from('customer_profiles').upsert({ user_id: adminCreated.user.id, cpf: '52998224725', full_name: 'Admin', birth_date: '1985-01-01', phone: '11999990000', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'admin profile');
  const admin = await clientFor(adminEmail, password);

  const event = await must(service.from('events').insert({
    organization_id: org.id, name: `Snapshot Evento ${suffix}`, year: 2026, slug: `snapshot-evento-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 100, female_price: 100 }), 'price');

  const cupItemId = await must(admin.rpc('upsert_store_item', {
    p_id: null, p_event_id: event.id, p_name: `Copo Snapshot ${suffix}`, p_slug: `copo-snapshot-${suffix}`,
    p_description: null, p_price: 60, p_requires_variant: false, p_is_active: true, p_sort_order: 0,
    p_supply_mode: 'stock', p_available_all_events: false,
  }), 'create cup item');
  await must(service.from('store_item_inventory').insert({ store_item_id: cupItemId, variant_id: null, total_quantity: 1000, reserved_quantity: 0, delivered_quantity: 0 }), 'cup inventory');

  const shirtItemId = await must(admin.rpc('upsert_store_item', {
    p_id: null, p_event_id: event.id, p_name: `Squeeze Snapshot ${suffix}`, p_slug: `squeeze-snapshot-${suffix}`,
    p_description: null, p_price: 40, p_requires_variant: false, p_is_active: true, p_sort_order: 0,
    p_supply_mode: 'stock', p_available_all_events: false,
  }), 'create squeeze item');
  await must(service.from('store_item_inventory').insert({ store_item_id: shirtItemId, variant_id: null, total_quantity: 1000, reserved_quantity: 0, delivered_quantity: 0 }), 'squeeze inventory');

  // Cada teste cria seu proprio comprador (email + CPF unicos): o checkout
  // ja bloqueia um titular assumir 2 ingressos ativos/reservados do MESMO
  // evento (HOLDER_ALREADY_HAS_TICKET_FOR_EVENT), entao reusar 1 comprador
  // pra 16 testes no mesmo evento colidiria a partir do primeiro teste que
  // chega a confirmar um ingresso de verdade (ex.: cupom que zera o total).
  async function freshBuyer() {
    const cpf = generateValidCpf();
    const email = `snapshot-buyer-${suffix}-${Math.random().toString(16).slice(2)}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), 'create buyer');
    await must(service.from('customer_profiles').upsert({ user_id: created.user.id, cpf, full_name: 'Buyer Snapshot', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');
    const client = await clientFor(email, password);
    return { client, email, cpf };
  }

  async function createOrder(quantity, holderMode = 'self') {
    const buyer = await freshBuyer();
    const items = Array.from({ length: quantity }, () => ({ ownership_mode: holderMode }));
    const r = await buyer.client.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: category.id, p_gender: 'male', p_quantity: quantity,
      p_payment_method: 'pix', p_buyer_full_name: 'Buyer Snapshot', p_buyer_cpf: buyer.cpf,
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: buyer.email, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_items: items, p_client_request_id: `snapshot-${Date.now()}-${Math.random()}`,
    });
    if (r.error) throw new Error(`create order (qty ${quantity}): ${JSON.stringify(r.error)}`);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return { orderId: row.order_id, buyer: buyer.client };
  }

  async function cartDetails(buyer, orderId) {
    const { data, error } = await buyer.rpc('get_cart_order_details', { p_order_id: orderId });
    if (error) throw new Error(`cart details: ${JSON.stringify(error)}`);
    return data;
  }

  async function createCoupon(overrides) {
    const r = await admin.rpc('create_organization_coupon', {
      p_organization_id: org.id, p_code: overrides.code, p_discount_type: overrides.discount_type ?? 'percentage',
      p_discount_value: overrides.discount_value ?? 10, p_applies_to_tickets: overrides.applies_to_tickets ?? false,
      p_applies_to_products: overrides.applies_to_products ?? false, p_max_uses: null, p_valid_from: null, p_valid_until: null,
      p_notes: null, p_is_active: true, p_event_ids: [], p_ticket_category_ids: [], p_store_item_ids: overrides.store_item_ids ?? [],
    });
    if (r.error) throw new Error(`create coupon ${overrides.code}: ${JSON.stringify(r.error)}`);
    return r.data;
  }

  async function finalize(buyer, orderId, method = 'pix') {
    const r = await buyer.rpc('finalize_cart_order_payment', { p_order_id: orderId, p_payment_method: method });
    if (r.error) throw new Error(`finalize: ${JSON.stringify(r.error)}`);
    return r.data;
  }

  async function markPaidAndConfirm(orderId) {
    await must(service.from('payments').update({ payment_status: 'paid', paid_at: new Date().toISOString() }).eq('order_id', orderId), 'mark paid');
    const items = await must(service.from('order_items').select('id').eq('order_id', orderId).not('status', 'in', '(cancelled,expired,refunded,transferred)'), 'items to confirm');
    await must(service.from('orders').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', orderId), 'confirm order');
    for (const item of items) {
      await must(service.rpc('confirm_order_item_and_issue_ticket', { p_order_item_id: item.id }), `confirm item ${item.id}`);
    }
  }

  return { service, admin, org, event, cupItemId, shirtItemId, freshBuyer, createOrder, cartDetails, createCoupon, finalize, markPaidAndConfirm, must };
}

const fx = await buildFixture();

test('somente 1 ingresso: snapshot unificado mostra 1 ingresso, 0 produtos', async () => {
  const { orderId, buyer } = await fx.createOrder(1);
  const cart = await fx.cartDetails(buyer, orderId);
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].item_kind, 'ticket');
  assert.equal(Number(cart.final_amount), 100);
});

test('2 ingressos: 2 linhas de ticket, cada uma quantity=1', async () => {
  const { orderId, buyer } = await fx.createOrder(2);
  const cart = await fx.cartDetails(buyer, orderId);
  const tickets = cart.items.filter((i) => i.item_kind === 'ticket');
  assert.equal(tickets.length, 2);
  assert.ok(tickets.every((t) => t.quantity === 1));
  assert.equal(Number(cart.final_amount), 200);
});

test('1 ingresso + 1 produto: ambos aparecem no snapshot unificado, total soma os dois', async () => {
  const { orderId, buyer } = await fx.createOrder(1);
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1 }), 'add cup');
  const cart = await fx.cartDetails(buyer, orderId);
  assert.equal(cart.items.filter((i) => i.item_kind === 'ticket').length, 1);
  assert.equal(cart.items.filter((i) => i.item_kind === 'product').length, 1);
  assert.equal(Number(cart.final_amount), 160);
});

test('2 ingressos + 2 unidades do mesmo produto: 1 linha de produto consolidada com quantity=2', async () => {
  const { orderId, buyer } = await fx.createOrder(2);
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1 }), 'add 1');
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1 }), 'add 1 de novo');
  const cart = await fx.cartDetails(buyer, orderId);
  const productItems = cart.items.filter((i) => i.item_kind === 'product');
  assert.equal(productItems.length, 1, 'deve consolidar em 1 linha, nao duas');
  assert.equal(productItems[0].quantity, 2);
  assert.equal(Number(cart.final_amount), 200 + 120);
});

test('multiplos produtos: cada produto e sua propria linha, snapshot lista todos', async () => {
  const { orderId, buyer } = await fx.createOrder(1);
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1 }), 'add cup');
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.shirtItemId, p_quantity: 1 }), 'add squeeze');
  const cart = await fx.cartDetails(buyer, orderId);
  const productItems = cart.items.filter((i) => i.item_kind === 'product');
  assert.equal(productItems.length, 2);
  assert.equal(Number(cart.final_amount), 100 + 60 + 40);
});

test('produto com quantity > 1: snapshot reflete quantidade e subtotal corretos', async () => {
  const { orderId, buyer } = await fx.createOrder(1);
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 5 }), 'add 5 copos');
  const cart = await fx.cartDetails(buyer, orderId);
  const line = cart.items.find((i) => i.item_kind === 'product');
  assert.equal(line.quantity, 5);
  assert.equal(Number(line.final_amount), 300);
  assert.equal(Number(cart.final_amount), 400);
});

test('cupom so ingresso: desconto aparece na linha de ingresso, produto fica de fora', async () => {
  const code = `SNAPTICKET-${Date.now()}`;
  await fx.createCoupon({ code, applies_to_tickets: true, applies_to_products: false, discount_value: 10 });
  const { orderId, buyer } = await fx.createOrder(1);
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1 }), 'add cup');
  await fx.must(buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: code }), 'apply coupon');

  const cart = await fx.cartDetails(buyer, orderId);
  const ticketLine = cart.items.find((i) => i.item_kind === 'ticket');
  const productLine = cart.items.find((i) => i.item_kind === 'product');
  assert.equal(Number(ticketLine.discount_amount), 10);
  assert.equal(Number(productLine.discount_amount), 0);
  assert.equal(Number(cart.final_amount), 90 + 60);
});

test('cupom so produto: desconto aparece na linha de produto, ingresso fica de fora', async () => {
  const code = `SNAPPROD-${Date.now()}`;
  await fx.createCoupon({ code, applies_to_tickets: false, applies_to_products: true, discount_value: 50 });
  const { orderId, buyer } = await fx.createOrder(1);
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1 }), 'add cup');
  await fx.must(buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: code }), 'apply coupon');

  const cart = await fx.cartDetails(buyer, orderId);
  const ticketLine = cart.items.find((i) => i.item_kind === 'ticket');
  const productLine = cart.items.find((i) => i.item_kind === 'product');
  assert.equal(Number(ticketLine.discount_amount), 0);
  assert.equal(Number(productLine.discount_amount), 30);
  assert.equal(Number(cart.final_amount), 100 + 30);
});

test('cupom misto: desconto distribuido entre ingresso e produto', async () => {
  const code = `SNAPMIX-${Date.now()}`;
  await fx.createCoupon({ code, applies_to_tickets: true, applies_to_products: true, discount_value: 10 });
  const { orderId, buyer } = await fx.createOrder(1);
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 1 }), 'add cup');
  await fx.must(buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: code }), 'apply coupon');

  const cart = await fx.cartDetails(buyer, orderId);
  const ticketLine = cart.items.find((i) => i.item_kind === 'ticket');
  const productLine = cart.items.find((i) => i.item_kind === 'product');
  assert.equal(Number(ticketLine.discount_amount), 10);
  assert.equal(Number(productLine.discount_amount), 6);
  assert.equal(Number(cart.final_amount), 90 + 54);
});

test('total final zero: cupom 100% fixo cobrindo tudo mantem carrinho e snapshot em R$0', async () => {
  const code = `SNAPZERO-${Date.now()}`;
  await fx.createCoupon({ code, applies_to_tickets: true, applies_to_products: false, discount_type: 'fixed', discount_value: 100 });
  const { orderId, buyer } = await fx.createOrder(1);
  await fx.must(buyer.rpc('apply_cart_coupon', { p_order_id: orderId, p_coupon_code: code }), 'apply coupon');

  const cart = await fx.cartDetails(buyer, orderId);
  assert.equal(Number(cart.final_amount), 0);

  const finalizeResult = await fx.finalize(buyer, orderId, 'pix');
  assert.equal(Number(finalizeResult.final_amount), 0);
  const cartAfter = await fx.cartDetails(buyer, orderId);
  assert.equal(Number(cartAfter.final_amount), 0);
});

test('total final > 0: carrinho e snapshot pos-finalize continuam identicos', async () => {
  const { orderId, buyer } = await fx.createOrder(1);
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 2 }), 'add 2 copos');
  const cartBefore = await fx.cartDetails(buyer, orderId);
  assert.equal(Number(cartBefore.final_amount), 220);

  const finalizeResult = await fx.finalize(buyer, orderId, 'pix');
  assert.equal(Number(finalizeResult.final_amount), 220);
});

test('carrinho -> pagamento mantem exatamente o mesmo total (produto continua visivel apos finalize)', async () => {
  const { orderId, buyer } = await fx.createOrder(2);
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 3 }), 'add 3 copos');
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.shirtItemId, p_quantity: 1 }), 'add squeeze');

  const cartBeforeFinalize = await fx.cartDetails(buyer, orderId);
  const totalBefore = Number(cartBeforeFinalize.final_amount);
  assert.equal(totalBefore, 200 + 180 + 40);

  await fx.finalize(buyer, orderId, 'pix');

  const cartAfterFinalize = await fx.cartDetails(buyer, orderId);
  assert.equal(Number(cartAfterFinalize.final_amount), totalBefore, 'total apos finalize deve ser IDENTICO ao total do carrinho');
  assert.equal(cartAfterFinalize.items.filter((i) => i.item_kind === 'ticket').length, 2);
  assert.equal(cartAfterFinalize.items.filter((i) => i.item_kind === 'product').length, 2, 'produtos continuam visiveis apos finalize, nao somem na etapa de pagamento');
});

test('PIX usa exatamente o total final do carrinho (payments.final_amount = get_cart_order_details.final_amount)', async () => {
  const { orderId, buyer } = await fx.createOrder(1);
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 2 }), 'add 2 copos');
  const cart = await fx.cartDetails(buyer, orderId);

  await fx.finalize(buyer, orderId, 'pix');

  const payment = await fx.must(fx.service.from('payments').select('final_amount').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).single(), 'payment row');
  assert.equal(Number(payment.final_amount), Number(cart.final_amount), 'valor que alimentaria o PIX deve bater com o total canonico do carrinho');
});

test('confirmacao final: apos pagamento confirmado, snapshot unificado continua trazendo ingressos com ticket_id e produtos', async () => {
  const { orderId, buyer } = await fx.createOrder(1);
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 2 }), 'add 2 copos');
  await fx.finalize(buyer, orderId, 'pix');
  await fx.markPaidAndConfirm(orderId);

  const cart = await fx.cartDetails(buyer, orderId);
  const ticketLine = cart.items.find((i) => i.item_kind === 'ticket');
  const productLine = cart.items.find((i) => i.item_kind === 'product');
  assert.ok(ticketLine.ticket_id, 'ingresso confirmado deve ter ticket_id no snapshot unificado');
  assert.equal(ticketLine.status, 'confirmed');
  assert.ok(productLine, 'produto deve continuar presente na confirmacao final');
  assert.equal(productLine.status, 'confirmed');
  assert.equal(productLine.quantity, 2);
});

test('Minha Conta: order_items item_kind=product continuam consultaveis apos conclusao (fonte da secao Produtos do pedido)', async () => {
  const { orderId, buyer } = await fx.createOrder(1);
  await fx.must(buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.cupItemId, p_quantity: 3 }), 'add 3 copos');
  await fx.finalize(buyer, orderId, 'pix');
  await fx.markPaidAndConfirm(orderId);

  const rows = await fx.must(
    buyer.from('order_items').select('id, quantity, unit_price, final_amount, status, store_items(name)').eq('order_id', orderId).eq('item_kind', 'product'),
    'product order_items for minha-conta page',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 3);
  assert.equal(rows[0].status, 'confirmed');
  const storeItem = Array.isArray(rows[0].store_items) ? rows[0].store_items[0] : rows[0].store_items;
  assert.ok(storeItem?.name);
});

test('isolamento: comprador nao acessa get_cart_order_details de pedido de outro usuario', async () => {
  const { orderId } = await fx.createOrder(1);
  const outsider = await fx.freshBuyer();

  const result = await outsider.client.rpc('get_cart_order_details', { p_order_id: orderId });
  assert.ok(result.error, 'usuario sem relacao com o pedido nao deve conseguir ler o snapshot unificado');
});
