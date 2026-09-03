// Testes de integracao da feature "QR de retirada configuravel por
// produto" (pickup_qr_mode: per_unit/per_line/none). Segue o MESMO padrao
// de fixture/autenticacao ja usado por tests/cart-product-quantity.integration.mjs
// -- URL/chaves SEMPRE fixas pro stack local (127.0.0.1:54321), nunca lidas
// de .env.local pra essas 3 chaves especificas, entao nunca ha risco de
// apontar pra produção mesmo que .env.local tenha credenciais reais.
//
// Requer: `supabase start` + `supabase db reset` rodando localmente (Docker
// Desktop ativo). Rodar com:
//   node --test tests/product-pickup-qr-mode.integration.mjs
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
  const org = await must(service.from('organizations').insert({ name: `Pickup QR Org ${suffix}`, slug: `pickup-qr-org-${suffix}` }).select('id').single(), 'org');

  const password = 'SenhaForte!123';
  let ownerRole = (await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle()).data;
  if (!ownerRole) ownerRole = await must(service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single(), 'owner role');
  let operationalRole = (await service.from('admin_roles').select('id').eq('code', 'operational').maybeSingle()).data;

  const adminEmail = `pickup-qr-admin-${suffix}@qa.local`;
  const buyerEmail = `pickup-qr-buyer-${suffix}@qa.local`;
  const buyer2Email = `pickup-qr-buyer2-${suffix}@qa.local`;
  const staffEmail = `pickup-qr-staff-${suffix}@qa.local`;
  const adminCreated = await must(service.auth.admin.createUser({ email: adminEmail, password, email_confirm: true }), 'create admin');
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'create buyer');
  const buyer2Created = await must(service.auth.admin.createUser({ email: buyer2Email, password, email_confirm: true }), 'create buyer2');
  const staffCreated = await must(service.auth.admin.createUser({ email: staffEmail, password, email_confirm: true }), 'create staff');

  await must(service.from('organization_members').insert([
    { organization_id: org.id, user_id: adminCreated.user.id, is_owner: true, is_active: true },
    { organization_id: org.id, user_id: staffCreated.user.id, is_owner: false, is_active: true },
  ]), 'members');
  await must(service.from('admin_users').insert({ user_id: adminCreated.user.id, role_id: ownerRole.id, is_active: true }), 'admin_users owner');
  if (operationalRole) {
    await must(service.from('admin_users').insert({ user_id: staffCreated.user.id, role_id: operationalRole.id, is_active: true }), 'admin_users staff');
  }
  for (const [userId, name, cpf] of [
    [adminCreated.user.id, 'Admin', '52998224725'],
    [buyerCreated.user.id, 'Buyer', '11144477735'],
    [buyer2Created.user.id, 'Buyer2', '88510113030'],
    [staffCreated.user.id, 'Staff', '15350946056'],
  ]) {
    await must(service.from('customer_profiles').upsert({ user_id: userId, cpf, full_name: name, birth_date: '1990-01-01', phone: '11999990000', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), `profile ${name}`);
  }

  const event = await must(service.from('events').insert({
    organization_id: org.id, name: `Pickup QR Evento ${suffix}`, year: 2026, slug: `pickup-qr-evento-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 100, female_price: 100 }), 'price');

  const admin = await clientFor(adminEmail, password);
  const buyer = await clientFor(buyerEmail, password);
  const buyer2 = await clientFor(buyer2Email, password);
  const staff = await clientFor(staffEmail, password);

  async function createStoreItem(name, pickupQrMode) {
    const id = await must(admin.rpc('upsert_store_item', {
      p_id: null, p_event_id: event.id, p_name: `${name} ${suffix}`, p_slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix}`,
      p_description: null, p_price: 50, p_requires_variant: false, p_is_active: true, p_sort_order: 0,
      p_supply_mode: 'stock', p_available_all_events: false, p_visibility: 'public', p_linked_event_kit_item_id: null,
      p_discount_type: null, p_discount_value: 0, p_pickup_qr_mode: pickupQrMode,
    }), `create store item ${name}`);
    await must(service.from('store_item_inventory').insert({ store_item_id: id, variant_id: null, total_quantity: 1000, reserved_quantity: 0, delivered_quantity: 0 }), `${name} inventory`);
    return id;
  }

  const perUnitItemId = await createStoreItem('PerUnit', 'per_unit');
  const perLineItemId = await createStoreItem('PerLine', 'per_line');
  const noneItemId = await createStoreItem('SemQr', 'none');

  // Varias suites deste arquivo confirmam o pagamento (fx.markOrderPaid),
  // o que EMITE o ticket de verdade (tickets.status='active') pro titular
  // identificado por CPF (materialize_self_checkout_holder, chamada dentro
  // de create_multi_ticket_order_checkout -- 20260815006400_atomic_self_
  // ticket_holder_uniqueness.sql). Reusar o MESMO CPF pra "self" em toda
  // chamada faria a 2a+ criacao de pedido no mesmo evento ser rejeitada com
  // HOLDER_ALREADY_HAS_TICKET_FOR_EVENT (regra de producao correta -- 1
  // pessoa nao pode ser titular de 2 ingressos ativos no mesmo evento; NAO
  // e um bug, exige apenas que cada pedido pago neste arquivo use um
  // titular distinto). cart-product-quantity.integration.mjs reusa o mesmo
  // CPF sem problema porque nunca confirma pagamento/emite ticket ali --
  // so testa manipulacao de carrinho, que fica sempre 'pending'.
  let cpfCounter = 0;
  function freshCpf() {
    cpfCounter += 1;
    const seed = `${Date.now()}${cpfCounter}`.slice(-9).padStart(9, '3');
    const base = seed.split('').map(Number);
    const calcDigit = (digits) => {
      let sum = 0;
      let weight = digits.length + 1;
      for (const d of digits) { sum += d * weight; weight -= 1; }
      const rest = sum % 11;
      return rest < 2 ? 0 : 11 - rest;
    };
    const d1 = calcDigit(base);
    const d2 = calcDigit([...base, d1]);
    return [...base, d1, d2].join('');
  }

  async function createTicketOrder(buyerClient = buyer, quantity = 1) {
    const cpf = freshCpf();
    const r = await buyerClient.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: category.id, p_gender: 'male', p_quantity: quantity,
      p_payment_method: 'pix', p_buyer_full_name: 'Buyer', p_buyer_cpf: cpf,
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_items: Array.from({ length: quantity }, () => ({ ownership_mode: 'self' })),
      p_client_request_id: `pickup-qr-${Date.now()}-${Math.random()}`,
    });
    if (r.error) throw new Error(`create order: ${JSON.stringify(r.error)}`);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return row.order_id;
  }

  async function markOrderPaid(orderId) {
    const payment = await must(service.from('payments').select('id').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1), 'find payment');
    const paymentId = payment[0].id;
    // Confirmacao real de pagamento: atualiza o payment pra paid e confirma
    // cada order_item (ticket ou produto) via confirm_order_item_and_issue_ticket
    // (mesma RPC que o webhook/simulador usa por item -- sem checagem de
    // permissao no corpo dela, seguro chamar via service role).
    await must(service.from('payments').update({ payment_status: 'paid', paid_at: new Date().toISOString() }).eq('id', paymentId), 'mark payment paid');
    await must(service.from('orders').update({ status: 'confirmed' }).eq('id', orderId), 'mark order confirmed');
    const items = await must(service.from('order_items').select('id').eq('order_id', orderId), 'list items');
    for (const item of items) {
      const r = await service.rpc('confirm_order_item_and_issue_ticket', { p_order_item_id: item.id });
      if (r.error) throw new Error(`confirm item ${item.id}: ${JSON.stringify(r.error)}`);
    }
    return paymentId;
  }

  async function cartDetails(buyerClient, orderId) {
    const { data, error } = await buyerClient.rpc('get_cart_order_details', { p_order_id: orderId });
    if (error) throw new Error(`cart details: ${JSON.stringify(error)}`);
    return data;
  }

  // Concede uma admin_permission a UM usuario especifico via
  // admin_user_permission_overrides (effect='allow') -- nunca ao papel
  // inteiro (evitaria contaminar outros testes que tambem usam fx.staff/
  // fx.admin). Um `db reset` do zero so semeia os papeis de sistema
  // 'owner'/'operational', e 'operational' nao vem com NENHUMA permissao
  // operacional por padrao (so dashboard.*/operations.view_report) --
  // permissoes como store.deliver normalmente vem do papel
  // 'administrator', que so existe em bancos com organizacoes reais
  // configuradas, nao no seed baseline. Conceder por override reproduz
  // exatamente esse cenario real sem depender desse papel existir.
  //
  // NAO precisa mais semear a linha em admin_permissions aqui: store.view/
  // store.manage/store.deliver agora sao garantidas por
  // 20260939000000_seed_missing_store_foundation_permissions.sql (fix do
  // gap encontrado nesta mesma investigacao -- essas 3 permissoes viviam
  // so em supabase/legacy_migrations_backup/, nunca aplicado por `db
  // reset`). O antigo fallback "insere em admin_permissions se nao
  // existir" foi removido daqui de proposito -- se a migration regredir,
  // este teste deve voltar a falhar alto (com "permission ...: 0 rows"),
  // nao mascarar o gap de novo silenciosamente.
  async function grantPermission(userId, code) {
    const permission = await must(service.from('admin_permissions').select('id').eq('code', code).single(), `permission ${code}`);
    // Idempotente: mais de um teste neste arquivo concede store.deliver ao
    // MESMO fx.staffUserId (fixture compartilhado) -- upsert com ignoreDuplicates
    // evita violar a PK (user_id, permission_id) na segunda chamada.
    await must(
      service.from('admin_user_permission_overrides')
        .upsert({ user_id: userId, permission_id: permission.id, effect: 'allow' }, { onConflict: 'user_id,permission_id', ignoreDuplicates: true }),
      `grant ${code} to ${userId}`,
    );
  }

  return {
    service, admin, buyer, buyer2, staff, org, event, category,
    perUnitItemId, perLineItemId, noneItemId, staffUserId: staffCreated.user.id,
    createTicketOrder, markOrderPaid, cartDetails, must, grantPermission,
  };
}

const fx = await buildFixture();

test('ingresso apenas: nenhuma unidade/qr de produto envolvida', async () => {
  const orderId = await fx.createTicketOrder();
  await fx.markOrderPaid(orderId);
  const cart = await fx.cartDetails(fx.buyer, orderId);
  assert.equal(cart.items.filter((i) => i.item_kind === 'product').length, 0);
  const ticket = await fx.must(fx.service.from('tickets').select('id, token, status').eq('order_id', orderId).limit(1), 'ticket');
  assert.equal(ticket[0].status, 'active');
});

test('produto per_unit, quantity=1: 1 unidade materializada, identidade propria', async () => {
  const orderId = await fx.createTicketOrder();
  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perUnitItemId, p_quantity: 1 }), 'add per_unit qty1');
  const itemId = added.order_item_ids[0];

  const units = await fx.must(fx.service.from('order_item_pickup_units').select('id, unit_index, qr_token, status').eq('order_item_id', itemId), 'units');
  assert.equal(units.length, 1, 'quantity=1 tambem materializa 1 unidade no modelo unico');
  assert.equal(units[0].unit_index, 1);
  assert.equal(units[0].status, 'reserved');

  await fx.markOrderPaid(orderId);
  const unitsAfterPay = await fx.must(fx.service.from('order_item_pickup_units').select('status').eq('order_item_id', itemId), 'units after pay');
  assert.equal(unitsAfterPay[0].status, 'confirmed');

  const deliver = await fx.admin.rpc('deliver_order_item_pickup_unit', { p_unit_id: units[0].id });
  assert.equal(deliver.error, null, deliver.error?.message);
  const line = await fx.must(fx.service.from('order_items').select('status, delivered_at').eq('id', itemId).single(), 'line status');
  assert.equal(line.status, 'delivered', 'linha-mae deve virar delivered quando a unica unidade e entregue');
});

test('produto per_unit, quantity=3: exatamente 3 identidades/QRs independentes', async () => {
  const orderId = await fx.createTicketOrder();
  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perUnitItemId, p_quantity: 3 }), 'add per_unit qty3');
  const itemId = added.order_item_ids[0];

  const units = await fx.must(fx.service.from('order_item_pickup_units').select('id, unit_index, qr_token').eq('order_item_id', itemId).order('unit_index'), 'units');
  assert.equal(units.length, 3);
  assert.deepEqual(units.map((u) => u.unit_index), [1, 2, 3]);
  const tokens = new Set(units.map((u) => u.qr_token));
  assert.equal(tokens.size, 3, 'os 3 qr_token devem ser distintos entre si');

  await fx.markOrderPaid(orderId);

  // Entrega parcial: so a unidade 1.
  const deliverOne = await fx.admin.rpc('deliver_order_item_pickup_unit', { p_unit_id: units[0].id });
  assert.equal(deliverOne.error, null, deliverOne.error?.message);
  let line = (await fx.must(fx.service.from('order_items').select('status').eq('id', itemId), 'line after 1')).find(Boolean);
  assert.equal(line.status, 'confirmed', 'linha nao pode virar delivered com 2 unidades ainda pendentes');

  // Reentrega da mesma unidade -- idempotente, nao falha nem duplica.
  const deliverOneAgain = await fx.admin.rpc('deliver_order_item_pickup_unit', { p_unit_id: units[0].id });
  assert.equal(deliverOneAgain.error, null);
  assert.equal(deliverOneAgain.data, true);

  await fx.must(fx.admin.rpc('deliver_order_item_pickup_unit', { p_unit_id: units[1].id }), 'deliver unit 2');
  await fx.must(fx.admin.rpc('deliver_order_item_pickup_unit', { p_unit_id: units[2].id }), 'deliver unit 3');
  line = (await fx.must(fx.service.from('order_items').select('status').eq('id', itemId), 'line after 3')).find(Boolean);
  assert.equal(line.status, 'delivered', 'todas as unidades entregues -> linha-mae vira delivered');
});

test('produto per_line, quantity=3: 1 unico QR (qr_token da linha), entrega e undo sao da linha inteira', async () => {
  const orderId = await fx.createTicketOrder();
  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perLineItemId, p_quantity: 3 }), 'add per_line qty3');
  const itemId = added.order_item_ids[0];

  const units = await fx.must(fx.service.from('order_item_pickup_units').select('id').eq('order_item_id', itemId), 'units per_line');
  assert.equal(units.length, 0, 'per_line nunca materializa unidade');

  await fx.markOrderPaid(orderId);

  const deliver = await fx.admin.rpc('deliver_order_item_product', { p_order_item_id: itemId });
  assert.equal(deliver.error, null, deliver.error?.message);
  const deliverAgain = await fx.admin.rpc('deliver_order_item_product', { p_order_item_id: itemId });
  assert.equal(deliverAgain.error, null, 'segunda entrega da mesma linha e idempotente');
  assert.equal(deliverAgain.data, true);

  const undoNoReason = await fx.admin.rpc('undo_order_item_product_delivery', { p_order_item_id: itemId, p_reason_code: null });
  assert.ok(undoNoReason.error, 'undo sem motivo deve ser rejeitado');

  const undoInvalidReason = await fx.admin.rpc('undo_order_item_product_delivery', { p_order_item_id: itemId, p_reason_code: 'motivo_invalido' });
  assert.ok(undoInvalidReason.error, 'codigo de motivo invalido deve ser rejeitado');

  const undoOk = await fx.admin.rpc('undo_order_item_product_delivery', { p_order_item_id: itemId, p_reason_code: 'operational_error' });
  assert.equal(undoOk.error, null, undoOk.error?.message);
  const line = (await fx.must(fx.service.from('order_items').select('status, delivered_at').eq('id', itemId), 'line after undo')).find(Boolean);
  assert.equal(line.status, 'confirmed');
  assert.equal(line.delivered_at, null);
});

test('produto none: nenhuma entrega por QR de linha nem de unidade', async () => {
  const orderId = await fx.createTicketOrder();
  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.noneItemId, p_quantity: 2 }), 'add none qty2');
  const itemId = added.order_item_ids[0];
  await fx.markOrderPaid(orderId);

  const deliver = await fx.admin.rpc('deliver_order_item_product', { p_order_item_id: itemId });
  assert.ok(deliver.error, 'linha modo none deve recusar entrega por QR de linha');
  assert.match(deliver.error.message, /nao usa QR de retirada/);
});

test('pedido misto 1 ingresso + 1 produto: cada um resolve/entrega independentemente', async () => {
  const orderId = await fx.createTicketOrder();
  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perLineItemId, p_quantity: 1 }), 'add product');
  await fx.markOrderPaid(orderId);

  const ticket = await fx.must(fx.service.from('tickets').select('id').eq('order_id', orderId), 'ticket');
  const checkin = await fx.admin.rpc('checkin_ticket_entry', { p_ticket_id: ticket[0].id });
  assert.equal(checkin.error, null, checkin.error?.message);

  const deliverProduct = await fx.admin.rpc('deliver_order_item_product', { p_order_item_id: added.order_item_ids[0] });
  assert.equal(deliverProduct.error, null, deliverProduct.error?.message);

  const ticketAfter = await fx.must(fx.service.from('tickets').select('status').eq('id', ticket[0].id), 'ticket after');
  assert.equal(ticketAfter[0].status, 'used', 'check-in do ingresso nunca deve ser afetado pela entrega do produto');
});

test('pedido misto 1 ingresso + 2 produtos diferentes: linhas separadas, nunca cruzadas', async () => {
  const orderId = await fx.createTicketOrder();
  const p1 = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perUnitItemId, p_quantity: 2 }), 'add p1');
  const p2 = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perLineItemId, p_quantity: 1 }), 'add p2');
  await fx.markOrderPaid(orderId);

  const cart = await fx.cartDetails(fx.buyer, orderId);
  const productItems = cart.items.filter((i) => i.item_kind === 'product');
  assert.equal(productItems.length, 2);
  const perUnitLine = productItems.find((i) => i.order_item_id === p1.order_item_ids[0]);
  assert.equal(perUnitLine.pickup_units.length, 2, 'linha per_unit deve expor 2 unidades no payload do carrinho');
  const perLineLine = productItems.find((i) => i.order_item_id === p2.order_item_ids[0]);
  assert.equal(perLineLine.pickup_units.length, 0);
});

test('1 ingresso + varios produtos (per_unit e per_line juntos): nenhuma interferencia entre linhas', async () => {
  // NOTA: nao testamos aqui 2+ ingressos no MESMO pedido (quantity>1 em
  // create_multi_ticket_order_checkout com multiplos p_items) porque o
  // formato exato de ownership_mode pra titulares alem do comprador
  // ('unassigned'/'named') tem regras proprias (materializacao de
  // contato/participante) fora do escopo desta feature -- verificar esse
  // combo especifico via QA manual no checkout real (ver checklist). Aqui
  // provamos a garantia que importa pra esta feature: multiplas linhas de
  // produto com modos DIFERENTES (per_unit + per_line) no mesmo pedido
  // nunca se cruzam nem interferem uma na outra.
  const orderId = await fx.createTicketOrder();
  const p1 = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perUnitItemId, p_quantity: 2 }), 'add p1');
  const p2 = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perLineItemId, p_quantity: 2 }), 'add p2');
  await fx.markOrderPaid(orderId);

  const tickets = await fx.must(fx.service.from('tickets').select('id').eq('order_id', orderId), 'tickets');
  assert.equal(tickets.length, 1);
  const cart = await fx.cartDetails(fx.buyer, orderId);
  assert.equal(cart.items.filter((i) => i.item_kind === 'ticket').length, 1);
  assert.equal(cart.items.filter((i) => i.item_kind === 'product').length, 2);
  assert.notEqual(p1.order_item_ids[0], p2.order_item_ids[0]);

  const units1 = await fx.must(fx.service.from('order_item_pickup_units').select('id').eq('order_item_id', p1.order_item_ids[0]), 'units p1');
  const units2 = await fx.must(fx.service.from('order_item_pickup_units').select('id').eq('order_item_id', p2.order_item_ids[0]), 'units p2');
  assert.equal(units1.length, 2, 'linha per_unit tem suas proprias unidades');
  assert.equal(units2.length, 0, 'linha per_line nunca tem unidades, mesmo com outra linha per_unit no mesmo pedido');
});

test('alterar pickup_qr_mode do produto depois da compra nao afeta pedidos existentes', async () => {
  // Item DEDICADO deste teste (nunca fx.perLineItemId) -- este teste muda a
  // config do produto de propósito, e mutar um item compartilhado do
  // fixture contaminaria qualquer teste que rodar depois e reusar
  // fx.perLineItemId esperando o modo original 'per_line'.
  const dedicatedItemId = await fx.must(fx.admin.rpc('upsert_store_item', {
    p_id: null, p_event_id: fx.event.id, p_name: `PerLineDedicado ${Date.now()}`, p_slug: `per-line-dedicado-${Date.now()}`,
    p_description: null, p_price: 50, p_requires_variant: false, p_is_active: true, p_sort_order: 0,
    p_supply_mode: 'stock', p_available_all_events: false, p_visibility: 'public', p_linked_event_kit_item_id: null,
    p_discount_type: null, p_discount_value: 0, p_pickup_qr_mode: 'per_line',
  }), 'create dedicated item');
  await fx.must(fx.service.from('store_item_inventory').insert({ store_item_id: dedicatedItemId, variant_id: null, total_quantity: 1000, reserved_quantity: 0, delivered_quantity: 0 }), 'dedicated item inventory');

  const orderId = await fx.createTicketOrder();
  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: dedicatedItemId, p_quantity: 2 }), 'add per_line');
  const itemId = added.order_item_ids[0];

  const beforeLine = await fx.must(fx.service.from('order_items').select('pickup_qr_mode').eq('id', itemId).single(), 'line before');
  assert.equal(beforeLine.pickup_qr_mode, 'per_line');

  // Muda a config do PRODUTO para per_unit.
  await fx.must(fx.admin.rpc('upsert_store_item', {
    p_id: dedicatedItemId, p_event_id: fx.event.id, p_name: `PerLineDedicado mudado`, p_slug: `perline-mudado-${Date.now()}`,
    p_description: null, p_price: 50, p_requires_variant: false, p_is_active: true, p_sort_order: 0,
    p_supply_mode: 'stock', p_available_all_events: false, p_visibility: 'public', p_linked_event_kit_item_id: null,
    p_discount_type: null, p_discount_value: 0, p_pickup_qr_mode: 'per_unit',
  }), 'change product mode');

  const storeItem = await fx.must(fx.service.from('store_items').select('pickup_qr_mode').eq('id', dedicatedItemId).single(), 'store item after change');
  assert.equal(storeItem.pickup_qr_mode, 'per_unit');

  // A linha JA CRIADA continua congelada em per_line -- nunca materializa
  // unidade retroativamente.
  const lineAfter = await fx.must(fx.service.from('order_items').select('pickup_qr_mode').eq('id', itemId).single(), 'line after change');
  assert.equal(lineAfter.pickup_qr_mode, 'per_line', 'pedido existente nunca reflete a mudanca de config do produto');
  const unitsAfter = await fx.must(fx.service.from('order_item_pickup_units').select('id').eq('order_item_id', itemId), 'units after change');
  assert.equal(unitsAfter.length, 0);

  // Uma compra NOVA do mesmo produto ja usa o modo novo.
  const orderId2 = await fx.createTicketOrder();
  const added2 = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId2, p_store_item_id: dedicatedItemId, p_quantity: 2 }), 'add new purchase');
  const line2 = await fx.must(fx.service.from('order_items').select('pickup_qr_mode').eq('id', added2.order_item_ids[0]).single(), 'line2');
  assert.equal(line2.pickup_qr_mode, 'per_unit', 'compra nova usa a config atual do produto');
});

test('undo exige motivo e permissao (store.undo_delivery, nunca store.deliver)', async () => {
  const orderId = await fx.createTicketOrder();
  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perLineItemId, p_quantity: 1 }), 'add product');
  const itemId = added.order_item_ids[0];
  await fx.markOrderPaid(orderId);
  await fx.must(fx.admin.rpc('deliver_order_item_product', { p_order_item_id: itemId }), 'deliver');

  // Um `db reset` do zero so semeia os papeis 'owner'/'operational', e
  // 'operational' nao vem com NENHUMA permissao operacional por padrao
  // (confirmado: so dashboard.*/operations.view_report) -- store.deliver
  // normalmente vem do papel 'administrator', que so existe em bancos com
  // organizacoes reais configuradas. Concede store.deliver explicitamente
  // a este usuario (via override, isolado -- nunca ao papel inteiro) pra
  // reproduzir o cenario real que o teste quer verificar: um operador que
  // PODE entregar mas nao pode desfazer.
  await fx.grantPermission(fx.staffUserId, 'store.deliver');
  const staffUndo = await fx.staff.rpc('undo_order_item_product_delivery', { p_order_item_id: itemId, p_reason_code: 'operational_error' });
  assert.ok(staffUndo.error, 'staff com store.deliver mas SEM store.undo_delivery deve ser bloqueado ao tentar desfazer');
  assert.match(staffUndo.error.message, /permissao/i);
});

test('cancelamento antes da retirada: linha e unidades sao canceladas, estoque liberado', async () => {
  const orderId = await fx.createTicketOrder();
  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perUnitItemId, p_quantity: 2 }), 'add product');
  const itemId = added.order_item_ids[0];
  await fx.markOrderPaid(orderId);

  const payment = await fx.must(fx.service.from('payments').select('id').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1), 'payment');
  const refund = await fx.service.rpc('_apply_terminal_order_payment_status', { p_payment_id: payment[0].id, p_target_status: 'refunded' });
  assert.equal(refund.error, null, refund.error?.message);

  const line = (await fx.must(fx.service.from('order_items').select('status').eq('id', itemId), 'line')).find(Boolean);
  assert.equal(line.status, 'refunded');
  const units = await fx.must(fx.service.from('order_item_pickup_units').select('status').eq('order_item_id', itemId), 'units');
  assert.ok(units.every((u) => u.status === 'cancelled'), 'todas as unidades pendentes devem ser canceladas junto com a linha');
});

test('cancelamento apos retirada parcial (per_unit): pedido de loja standalone bloqueia cancelamento', async () => {
  // Este cenario usa o dominio de loja standalone (store_orders/
  // store_order_items) porque cancel_store_order e a RPC que tem a guarda
  // explicita de "unidade ja entregue bloqueia cancelamento" -- o dominio
  // "compre junto" nao tem uma RPC generica de "cancelar linha paga"
  // equivalente (o estorno de pagamento e o caminho, testado abaixo).
  const perUnitId = await fx.must(fx.admin.rpc('upsert_store_item', {
    p_id: null, p_event_id: fx.event.id, p_name: `StorePerUnit ${Date.now()}`, p_slug: `store-per-unit-${Date.now()}`,
    p_description: null, p_price: 40, p_requires_variant: false, p_is_active: true, p_sort_order: 0,
    p_supply_mode: 'stock', p_available_all_events: false, p_visibility: 'public', p_linked_event_kit_item_id: null,
    p_discount_type: null, p_discount_value: 0, p_pickup_qr_mode: 'per_unit',
  }), 'create store per_unit item');
  await fx.must(fx.service.from('store_item_inventory').insert({ store_item_id: perUnitId, variant_id: null, total_quantity: 100, reserved_quantity: 0, delivered_quantity: 0 }), 'inventory');

  const order = await fx.must(fx.buyer.rpc('create_store_order', {
    p_event_id: fx.event.id, p_items: [{ store_item_id: perUnitId, variant_id: null, quantity: 2 }], p_payment_method: 'pix',
  }), 'create store order');
  const storeOrderId = Array.isArray(order) ? order[0].store_order_id : order.store_order_id;
  await fx.must(fx.admin.rpc('confirm_store_order_payment', { p_store_order_id: storeOrderId }), 'confirm payment');

  const line = await fx.must(fx.service.from('store_order_items').select('id').eq('store_order_id', storeOrderId), 'line');
  const units = await fx.must(fx.service.from('store_order_item_pickup_units').select('id').eq('store_order_item_id', line[0].id).order('unit_index'), 'units');
  await fx.must(fx.admin.rpc('deliver_store_order_item_pickup_unit', { p_unit_id: units[0].id }), 'deliver unit 1');

  const cancel = await fx.admin.rpc('cancel_store_order', { p_store_order_id: storeOrderId, p_reason: 'teste' });
  assert.ok(cancel.error, 'pedido com QUALQUER unidade entregue nao pode ser cancelado, mesmo a linha nao estando delivered ainda');
});

test('estorno apos retirada parcial (compre junto) nao deixa estado impossivel: linha com unidade entregue e excluida da reversao em massa', async () => {
  const orderId = await fx.createTicketOrder();
  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perUnitItemId, p_quantity: 2 }), 'add product');
  const itemId = added.order_item_ids[0];
  await fx.markOrderPaid(orderId);

  const units = await fx.must(fx.service.from('order_item_pickup_units').select('id, unit_index').eq('order_item_id', itemId).order('unit_index'), 'units');
  await fx.must(fx.admin.rpc('deliver_order_item_pickup_unit', { p_unit_id: units[0].id }), 'deliver unit 1');

  const payment = await fx.must(fx.service.from('payments').select('id').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1), 'payment');
  const refund = await fx.service.rpc('_apply_terminal_order_payment_status', { p_payment_id: payment[0].id, p_target_status: 'refunded' });
  assert.equal(refund.error, null, refund.error?.message);

  const line = (await fx.must(fx.service.from('order_items').select('status').eq('id', itemId), 'line')).find(Boolean);
  assert.equal(line.status, 'confirmed', 'linha com unidade ja entregue fica de fora da reversao em massa (nunca vira refunded silenciosamente)');
  const unitsAfter = await fx.must(fx.service.from('order_item_pickup_units').select('status').eq('order_item_id', itemId).order('unit_index'), 'units after');
  assert.equal(unitsAfter[0].status, 'delivered', 'unidade ja entregue nunca e revertida pelo estorno em massa');
  assert.equal(unitsAfter[1].status, 'confirmed', 'unidade pendente NAO e cancelada automaticamente -- linha ficou fora da cascata inteira, requer decisao manual');
});

test('PAID_ORDER_WITHOUT_TICKET ignora produtos de loja (so item_kind=ticket entra no detector)', async () => {
  const orderId = await fx.createTicketOrder();
  await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perLineItemId, p_quantity: 1 }), 'add product');
  await fx.markOrderPaid(orderId);
  // Cancela o ticket administrativamente COM intencao de substituicao --
  // simula o caso real que o detector cobre (entitlement ainda aberto,
  // nenhum ingresso substituto emitido). cancellation_replacement_required
  // e a INTENCAO declarada no cancelamento (20260924000000_ticket_
  // cancellation_replacement_intent.sql): true = "espera-se substituto,
  // detector continua bloqueando"; false = "entitlement encerrado
  // definitivamente, nunca flagged". Sem substituto emitido, tem que ser
  // true pra aparecer no detector -- false e exatamente o caso que o
  // FIX desta migration passou a EXCLUIR do detector.
  const tickets = await fx.must(fx.service.from('tickets').select('id, order_item_id').eq('order_id', orderId), 'tickets');
  await fx.must(fx.service.from('tickets').update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancellation_replacement_required: true }).eq('id', tickets[0].id), 'cancel ticket');

  const { data: issues, error } = await fx.service.rpc('detect_integrity_paid_order_without_ticket', { p_organization_id: fx.org.id, p_event_id: fx.event.id });
  assert.equal(error, null, error?.message);
  const flagged = (issues ?? []).map((i) => i.entity_id);
  assert.ok(flagged.includes(tickets[0].order_item_id), 'order_item do ticket cancelado sem substituicao, num pedido pago, deve ser flagged pelo detector');

  // A linha de PRODUTO desta compra nunca pode aparecer no detector -- e a
  // garantia central deste teste (item_kind='product' e explicitamente
  // filtrado fora, ver 20260925000000_fix_paid_order_without_ticket_item_kind.sql).
  const productLineIds = (await fx.must(fx.service.from('order_items').select('id').eq('order_id', orderId).eq('item_kind', 'product'), 'product lines')).map((r) => r.id);
  assert.ok(productLineIds.length > 0, 'sanity: deveria existir 1 linha de produto neste pedido');
  for (const id of productLineIds) {
    assert.ok(!flagged.includes(id), `order_item de produto ${id} nunca deve aparecer em PAID_ORDER_WITHOUT_TICKET`);
  }
});

test('qr_token bruto nunca aparece no payload de get_cart_order_details nem de list_operational_product_items', async () => {
  const orderId = await fx.createTicketOrder();
  await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perUnitItemId, p_quantity: 3 }), 'add per_unit');
  await fx.markOrderPaid(orderId);

  const cart = await fx.cartDetails(fx.buyer, orderId);
  const cartJson = JSON.stringify(cart);
  assert.ok(!/"qr_token"/.test(cartJson), 'get_cart_order_details nunca deve expor a chave qr_token');

  const { data: listRows, error } = await fx.admin.rpc('list_operational_product_items', { p_status: null, p_event_id: fx.event.id, p_search: null, p_date_from: null, p_date_to: null });
  assert.equal(error, null, error?.message);
  const listJson = JSON.stringify(listRows);
  assert.ok(!/"qr_token"/.test(listJson) && !/ITEM-|UNIT-/.test(listJson), 'list_operational_product_items nunca deve expor qr_token nem o formato do token');
});

test('usuario so acessa QR/unidades de pedidos aos quais tem direito (RLS); equipe autorizada opera via RPC mesmo sem orders.view', async () => {
  const orderId = await fx.createTicketOrder(fx.buyer);
  const added = await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.perUnitItemId, p_quantity: 2 }), 'add product');
  await fx.markOrderPaid(orderId);

  const ownUnits = await fx.buyer.from('order_item_pickup_units').select('id').eq('order_item_id', added.order_item_ids[0]);
  assert.equal(ownUnits.error, null);
  assert.equal(ownUnits.data.length, 2, 'o proprio comprador ve as unidades do seu pedido');

  const otherUnits = await fx.buyer2.from('order_item_pickup_units').select('id').eq('order_item_id', added.order_item_ids[0]);
  assert.equal(otherUnits.error, null);
  assert.equal(otherUnits.data.length, 0, 'outro usuario NAO deve ver unidades de um pedido que nao e dele (RLS)');

  // ACHADO NA INVESTIGACAO (nao e bug, e reflexo de um gap ja documentado e
  // ja contornado na aplicacao): orders/order_items (dominio "compre
  // junto") tem RLS restrita a permissoes especificas (orders.view/
  // finance.*/participants.view/checkin.*/kits.*) -- NUNCA store.deliver.
  // Por isso as rotas de QR e os resolvers da Central para este dominio
  // usam client de SERVICE ROLE + checagem explicita de store.deliver em
  // codigo (ver src/app/api/inscricao/.../qrcode/route.ts e
  // src/app/operacoes/actions.ts), nunca dependem de RLS direta aqui. Um
  // operador com so store.deliver (sem nenhuma das outras permissoes)
  // corretamente NAO ve a linha via uma query RLS pura -- confirmando que
  // minha policy order_item_pickup_units_select (que faz join ate orders)
  // herda esse mesmo gap por natureza (esperado, simetrico ao dominio
  // "compre junto" inteiro, nao uma regressao desta feature).
  await fx.grantPermission(fx.staffUserId, 'store.deliver');
  const staffUnitsViaRLS = await fx.staff.from('order_item_pickup_units').select('id').eq('order_item_id', added.order_item_ids[0]);
  assert.equal(staffUnitsViaRLS.error, null);
  assert.equal(staffUnitsViaRLS.data.length, 0, 'staff com store.deliver mas sem orders.view/participants.view/checkin.* nao ve a linha via RLS direta -- mesmo gap ja documentado do dominio orders/order_items, contornado na aplicacao via service role');

  // A garantia real de "equipe autorizada consegue abrir/operar o item" e
  // a RPC de entrega, gated SO por store.deliver (security definer, nunca
  // depende de RLS de orders/order_items) -- exatamente o mecanismo que a
  // aplicacao usa de verdade.
  const units = await fx.must(fx.service.from('order_item_pickup_units').select('id').eq('order_item_id', added.order_item_ids[0]).order('unit_index'), 'units');
  const staffDeliver = await fx.staff.rpc('deliver_order_item_pickup_unit', { p_unit_id: units[0].id });
  assert.equal(staffDeliver.error, null, staffDeliver.error?.message);
  assert.equal(staffDeliver.data, true, 'staff com store.deliver consegue entregar a unidade via RPC mesmo sem orders.view/participants.view (nao depende de RLS de orders/order_items)');
});
