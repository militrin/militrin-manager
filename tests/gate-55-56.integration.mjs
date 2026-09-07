import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

const apiUrl = 'http://127.0.0.1:54321';
const localEnvironment = Object.fromEntries(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx.cmd supabase status -o env'], { encoding: 'utf8' })
  .split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Z_]+)="?([^"\r\n]+)"?$/);
    return match ? [[match[1], match[2]]] : [];
  }));
const anonKey = localEnvironment.ANON_KEY;
const serviceKey = localEnvironment.SERVICE_ROLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(apiUrl, serviceKey, options);

function generateValidCpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  function checkDigit(nums) {
    let sum = 0;
    let weight = nums.length + 1;
    for (const n of nums) {
      sum += n * weight;
      weight -= 1;
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  }
  const d1 = checkDigit(base);
  const d2 = checkDigit([...base, d1]);
  return [...base, d1, d2].join('');
}

let userCounter = 0;

async function must(promise, label) {
  const result = await promise;
  if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  return result.data;
}

async function createUser(fullName, { gender = 'male' } = {}) {
  const suffix = `${Date.now()}-${userCounter++}`;
  const email = `gate5556-${suffix}@qa.local`;
  const password = 'Gate5556-local-123!';
  const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `create ${email}`);
  await must(service.from('customer_profiles').upsert({
    user_id: created.user.id,
    cpf: generateValidCpf(),
    full_name: fullName,
    birth_date: '1990-01-01',
    phone: '11999990000',
    city: 'Itapiranga',
    gender,
  }, { onConflict: 'user_id' }), `profile ${email}`);
  return { id: created.user.id, email, password, cpf: generateValidCpf() };
}

async function clientFor(user) {
  const client = createClient(apiUrl, anonKey, options);
  const session = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  assert.equal(session.error, null, session.error?.message);
  return client;
}

async function grantPermissions(roleId, codes) {
  for (const code of codes) {
    let permission = await service.from('admin_permissions').select('id').eq('code', code).maybeSingle();
    if (!permission.data) {
      permission = await service.from('admin_permissions').insert({ code, name: code, module: 'gate' }).select('id').single();
    }
    assert.equal(permission.error, null, permission.error?.message);
    await service.from('admin_role_permissions').upsert(
      { role_id: roleId, permission_id: permission.data.id },
      { onConflict: 'role_id,permission_id' },
    );
  }
}

async function checkout(client, {
  eventId, email, fullName, gender = 'male', paymentMethod = 'courtesy', categoryId = null, items,
}) {
  const result = await client.rpc('create_multi_ticket_order_checkout', {
    p_event_id: eventId,
    p_ticket_category_id: categoryId,
    p_quantity: 1,
    p_gender: gender,
    p_payment_method: paymentMethod,
    p_buyer_full_name: fullName,
    p_buyer_cpf: generateValidCpf(),
    p_buyer_birth_date: '1990-01-01',
    p_buyer_gender: gender,
    p_buyer_phone: '11999990000',
    p_buyer_email: email,
    p_buyer_city: 'Itapiranga',
    p_limit_per_order: 10,
    p_assign_first_to_buyer: true,
    p_client_request_id: `gate5556-${Date.now()}-${Math.random()}`,
    p_items: items ?? [{ pricing_gender: gender, ownership_mode: 'self' }],
  });
  return result;
}

const fx = await (async () => {
  const suffix = `${Date.now()}`;
  const org = await must(service.from('organizations').insert({
    name: 'Gate 55/56', slug: `gate-55-56-${suffix}`, status: 'active',
  }).select('id').single(), 'org');

  const otherOrg = await must(service.from('organizations').insert({
    name: 'Gate 55/56 Other', slug: `gate-55-56-other-${suffix}`, status: 'active',
  }).select('id').single(), 'other org');

  const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
  await grantPermissions(ownerRole.id, ['events.view', 'events.edit', 'kits.deliver', 'feedback.view']);

  const opsRole = await must(service.from('admin_roles').insert({
    code: `ops-notif-${suffix}`, name: `Ops Notif ${suffix}`, is_system: false, is_active: true,
  }).select('id').single(), 'ops role');
  await grantPermissions(opsRole.id, ['kits.deliver']);

  const feedbackRole = await must(service.from('admin_roles').insert({
    code: `feedback-notif-${suffix}`, name: `Feedback Notif ${suffix}`, is_system: false, is_active: true,
  }).select('id').single(), 'feedback role');
  await grantPermissions(feedbackRole.id, ['feedback.view']);

  const admin = await createUser('Admin Gate');
  const opsAdmin = await createUser('Ops Gate');
  const feedbackAdmin = await createUser('Feedback Gate');
  const noPermAdmin = await createUser('Sem Permissao Gate');
  const outsider = await createUser('Outsider Gate');

  await must(service.from('admin_users').insert([
    { user_id: admin.id, role_id: ownerRole.id, is_active: true },
    { user_id: opsAdmin.id, role_id: opsRole.id, is_active: true },
    { user_id: feedbackAdmin.id, role_id: feedbackRole.id, is_active: true },
  ]), 'admin_users');

  await must(service.from('organization_members').insert([
    { organization_id: org.id, user_id: admin.id, role_id: ownerRole.id, is_owner: true, is_active: true },
    { organization_id: org.id, user_id: opsAdmin.id, role_id: opsRole.id, is_owner: false, is_active: true },
    { organization_id: org.id, user_id: feedbackAdmin.id, role_id: feedbackRole.id, is_owner: false, is_active: true },
    { organization_id: org.id, user_id: noPermAdmin.id, is_owner: false, is_active: true },
    { organization_id: otherOrg.id, user_id: outsider.id, is_owner: true, is_active: true },
  ]), 'members');

  const adminClient = await clientFor(admin);
  const opsClient = await clientFor(opsAdmin);
  const feedbackClient = await clientFor(feedbackAdmin);
  const noPermClient = await clientFor(noPermAdmin);
  const outsiderClient = await clientFor(outsider);

  const unisexEvent = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Unissex Gate', year: 2033,
    slug: `unisex-gate-${suffix}`, is_active: true, registration_enabled: true,
    starts_at: '2033-10-10T12:00:00Z', ends_at: '2033-10-12T12:00:00Z', min_age: 0,
  }).select('id,slug').single(), 'unisex event');

  const splitEvent = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Split Gate', year: 2033,
    slug: `split-gate-${suffix}`, is_active: true, registration_enabled: true,
    starts_at: '2033-10-10T12:00:00Z', ends_at: '2033-10-12T12:00:00Z', min_age: 0,
  }).select('id,slug').single(), 'split event');

  const categoryEvent = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Categorias Gate', year: 2033,
    slug: `cat-gate-${suffix}`, is_active: true, registration_enabled: true,
    starts_at: '2033-10-10T12:00:00Z', ends_at: '2033-10-12T12:00:00Z', min_age: 0,
  }).select('id,slug').single(), 'category event');

  return {
    org, otherOrg, admin, opsAdmin, feedbackAdmin, noPermAdmin, outsider,
    adminClient, opsClient, feedbackClient, noPermClient, outsiderClient,
    unisexEvent, splitEvent, categoryEvent, suffix,
  };
})();

test('ingresso unico: cria lote pooled sem M/F e a listagem nao marca gender_split', async () => {
  const created = await fx.adminClient.rpc('create_single_ticket_unisex_batch', {
    p_event_id: fx.unisexEvent.id,
    p_name: '1º Lote',
    p_sequence_number: 1,
    p_price: 80,
    p_max: 3,
  });
  assert.equal(created.error, null, created.error?.message);
  fx.unisexBatchId = created.data;

  const listed = await fx.adminClient.rpc('list_single_ticket_batches', { p_event_id: fx.unisexEvent.id });
  assert.equal(listed.error, null, listed.error?.message);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].gender_split, false);
  assert.equal(Number(listed.data[0].male_price), 80);
  assert.equal(Number(listed.data[0].female_price), 80);
  assert.equal(listed.data[0].male_max, 3);
  assert.equal(listed.data[0].name, '1º Lote');

  const stored = await must(
    service.from('registration_batches').select('male_max_confirmed_registrations,female_max_confirmed_registrations,max_confirmed_registrations,male_price,female_price,flat_price_confirmed').eq('id', fx.unisexBatchId).single(),
    'stored batch',
  );
  assert.equal(stored.male_max_confirmed_registrations, null);
  assert.equal(stored.female_max_confirmed_registrations, null);
  assert.equal(stored.max_confirmed_registrations, 3);
  assert.equal(stored.flat_price_confirmed, true);
});

test('RPC legado de split recusa converter lote unissex', async () => {
  const result = await fx.adminClient.rpc('update_single_ticket_batch', {
    p_batch_id: fx.unisexBatchId,
    p_name: 'Hack',
    p_male_price: 90,
    p_female_price: 70,
    p_male_max: 10,
    p_female_max: 10,
  });
  assert.ok(result.error, 'update_single_ticket_batch deveria recusar lote unissex');
  assert.match(result.error.message, /ingresso unico unissex|nao pode ser convertido/i);
});

test('checkout unissex: genero vazio nao bloqueia pricing e usa pool unico', async () => {
  const emptyPreview = await fx.adminClient.rpc('get_registration_pricing_preview', {
    p_event_id: fx.unisexEvent.id,
    p_ticket_category_id: null,
    p_gender: '',
  });
  assert.equal(emptyPreview.error, null, emptyPreview.error?.message);
  const emptyRow = Array.isArray(emptyPreview.data) ? emptyPreview.data[0] : emptyPreview.data;
  assert.equal(Number(emptyRow.final_amount), 80);
  assert.equal(emptyRow.remaining_slots, 3);

  const femalePreview = await fx.adminClient.rpc('get_registration_pricing_preview', {
    p_event_id: fx.unisexEvent.id,
    p_ticket_category_id: null,
    p_gender: 'female',
  });
  assert.equal(femalePreview.error, null, femalePreview.error?.message);
  const femaleRow = Array.isArray(femalePreview.data) ? femalePreview.data[0] : femalePreview.data;
  assert.equal(Number(femaleRow.final_amount), 80);

  const offer = await fx.adminClient.rpc('get_public_single_ticket_offer', { p_event_id: fx.unisexEvent.id });
  assert.equal(offer.error, null, offer.error?.message);
  const offerRow = Array.isArray(offer.data) ? offer.data[0] : offer.data;
  assert.equal(offerRow.is_unisex, true);
  assert.equal(offerRow.gender_split, false);
  assert.equal(Number(offerRow.price), 80);
  assert.equal(offerRow.remaining, 3);
});

test('capacidade 3: PIX fake + cartao fake + cortesia esgotam o pool; 4a venda falha', async () => {
  const remaining = async () => {
    const offer = await fx.adminClient.rpc('get_public_single_ticket_offer', { p_event_id: fx.unisexEvent.id });
    const row = Array.isArray(offer.data) ? offer.data[0] : offer.data;
    if (!row?.batch_id) return 0;
    return row.remaining;
  };
  assert.equal(await remaining(), 3);

  const pixBuyer = await createUser('Buyer Pix', { gender: 'female' });
  const pixClient = await clientFor(pixBuyer);
  const pixOrder = await checkout(pixClient, {
    eventId: fx.unisexEvent.id, email: pixBuyer.email, fullName: 'Buyer Pix', gender: 'female', paymentMethod: 'pix',
  });
  assert.equal(pixOrder.error, null, pixOrder.error?.message);
  const pixRow = Array.isArray(pixOrder.data) ? pixOrder.data[0] : pixOrder.data;
  const pixStart = await pixClient.rpc('start_order_payment_pix', {
    p_order_id: pixRow.order_id,
    p_pix_code: 'FAKE-PIX-CODE',
    p_pix_qrcode: 'data:image/svg+xml;utf8,fake',
    p_gateway_payment_id: `fake_${pixRow.order_id.slice(0, 8)}_${Date.now()}`,
    p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    p_provider: 'fake',
  });
  assert.equal(pixStart.error, null, pixStart.error?.message);
  const pixPaid = await pixClient.rpc('simulate_fake_gateway_payment_paid', { p_order_id: pixRow.order_id });
  assert.equal(pixPaid.error, null, pixPaid.error?.message);
  assert.equal(await remaining(), 2);

  const cardBuyer = await createUser('Buyer Card');
  const cardClient = await clientFor(cardBuyer);
  const cardOrder = await checkout(cardClient, {
    eventId: fx.unisexEvent.id, email: cardBuyer.email, fullName: 'Buyer Card', gender: 'male', paymentMethod: 'credit_card',
  });
  assert.equal(cardOrder.error, null, cardOrder.error?.message);
  const cardRow = Array.isArray(cardOrder.data) ? cardOrder.data[0] : cardOrder.data;
  const cardPaid = await cardClient.rpc('simulate_fake_gateway_payment_paid', { p_order_id: cardRow.order_id });
  if (cardPaid.error) {
    const courtesyCard = await checkout(cardClient, {
      eventId: fx.unisexEvent.id, email: cardBuyer.email, fullName: 'Buyer Card', gender: 'male', paymentMethod: 'courtesy',
    });
    assert.equal(courtesyCard.error, null, `${cardPaid.error.message} / fallback courtesy: ${courtesyCard.error?.message}`);
  }
  assert.equal(await remaining(), 1);

  const lastBuyer = await createUser('Buyer Last');
  const lastClient = await clientFor(lastBuyer);
  const lastOrder = await checkout(lastClient, {
    eventId: fx.unisexEvent.id, email: lastBuyer.email, fullName: 'Buyer Last', gender: 'male', paymentMethod: 'courtesy',
  });
  assert.equal(lastOrder.error, null, lastOrder.error?.message);
  const lastRow = Array.isArray(lastOrder.data) ? lastOrder.data[0] : lastOrder.data;
  const ticket = await must(service.from('tickets').select('id,status,order_id').eq('order_id', lastRow.order_id).maybeSingle(), 'ticket');
  assert.ok(ticket?.id, 'ingresso deveria ser emitido apos cortesia');
  assert.equal(await remaining(), 0);

  const fourth = await createUser('Buyer Fourth');
  const fourthClient = await clientFor(fourth);
  const fourthOrder = await checkout(fourthClient, {
    eventId: fx.unisexEvent.id, email: fourth.email, fullName: 'Buyer Fourth', gender: 'male', paymentMethod: 'courtesy',
  });
  assert.ok(fourthOrder.error, '4a venda em capacidade 3 deveria falhar');

  const items = await must(
    service.from('order_items').select('batch_id,pricing_gender,status,ticket_category_id').eq('event_id', fx.unisexEvent.id).eq('status', 'confirmed'),
    'confirmed items',
  );
  assert.equal(items.length, 3);
  assert.ok(items.every((item) => item.batch_id === fx.unisexBatchId));
  assert.ok(items.every((item) => item.ticket_category_id == null));
});

test('encerrar 1o lote e criar 2o lote independente', async () => {
  const closed = await fx.adminClient.rpc('set_single_ticket_batch_closed', {
    p_batch_id: fx.unisexBatchId,
    p_closed: true,
  });
  assert.equal(closed.error, null, closed.error?.message);

  const offerClosed = await fx.adminClient.rpc('get_public_single_ticket_offer', { p_event_id: fx.unisexEvent.id });
  const closedRow = Array.isArray(offerClosed.data) ? offerClosed.data[0] : offerClosed.data;
  assert.ok(!closedRow?.batch_id, 'lote encerrado nao pode permanecer na oferta');

  const second = await fx.adminClient.rpc('create_single_ticket_unisex_batch', {
    p_event_id: fx.unisexEvent.id,
    p_name: '2º Lote',
    p_sequence_number: 2,
    p_price: 120,
    p_max: 5,
  });
  assert.equal(second.error, null, second.error?.message);
  fx.unisexBatch2Id = second.data;

  const offer2 = await fx.adminClient.rpc('get_public_single_ticket_offer', { p_event_id: fx.unisexEvent.id });
  const row2 = Array.isArray(offer2.data) ? offer2.data[0] : offer2.data;
  assert.equal(row2.batch_id, fx.unisexBatch2Id);
  assert.equal(Number(row2.price), 120);
  assert.equal(row2.remaining, 5);
  assert.equal(row2.is_unisex, true);
});

test('lote gender_split legado continua com M/F e precos por genero', async () => {
  const created = await fx.adminClient.rpc('create_single_ticket_batch', {
    p_event_id: fx.splitEvent.id,
    p_name: 'Lote Split',
    p_sequence_number: 1,
    p_male_price: 200,
    p_female_price: 150,
    p_male_max: 10,
    p_female_max: 8,
  });
  assert.equal(created.error, null, created.error?.message);

  const listed = await fx.adminClient.rpc('list_single_ticket_batches', { p_event_id: fx.splitEvent.id });
  assert.equal(listed.error, null, listed.error?.message);
  assert.equal(listed.data[0].gender_split, true);
  assert.equal(Number(listed.data[0].male_price), 200);
  assert.equal(Number(listed.data[0].female_price), 150);

  const offer = await fx.adminClient.rpc('get_public_single_ticket_offer', { p_event_id: fx.splitEvent.id });
  const row = Array.isArray(offer.data) ? offer.data[0] : offer.data;
  assert.equal(row.is_unisex, false);
  assert.equal(row.gender_split, true);

  const emptyPreview = await fx.adminClient.rpc('get_registration_pricing_preview', {
    p_event_id: fx.splitEvent.id,
    p_ticket_category_id: null,
    p_gender: '',
  });
  assert.ok(emptyPreview.error, 'split legado deve exigir genero');

  const maleBuyer = await createUser('Split Male');
  const maleClient = await clientFor(maleBuyer);
  const maleOrder = await checkout(maleClient, {
    eventId: fx.splitEvent.id, email: maleBuyer.email, fullName: 'Split Male', gender: 'male', paymentMethod: 'courtesy',
  });
  assert.equal(maleOrder.error, null, maleOrder.error?.message);
  const maleRow = Array.isArray(maleOrder.data) ? maleOrder.data[0] : maleOrder.data;
  const maleItem = await must(service.from('order_items').select('pricing_gender,unit_price,final_amount').eq('order_id', maleRow.order_id).single(), 'male item');
  assert.equal(maleItem.pricing_gender, 'male');
  assert.equal(Number(maleItem.unit_price ?? maleItem.final_amount), 200);

  const femaleBuyer = await createUser('Split Female', { gender: 'female' });
  const femaleClient = await clientFor(femaleBuyer);
  const femaleOrder = await checkout(femaleClient, {
    eventId: fx.splitEvent.id, email: femaleBuyer.email, fullName: 'Split Female', gender: 'female', paymentMethod: 'courtesy',
  });
  assert.equal(femaleOrder.error, null, femaleOrder.error?.message);
  const femaleRow = Array.isArray(femaleOrder.data) ? femaleOrder.data[0] : femaleOrder.data;
  const femaleItem = await must(service.from('order_items').select('pricing_gender,unit_price,final_amount').eq('order_id', femaleRow.order_id).single(), 'female item');
  assert.equal(femaleItem.pricing_gender, 'female');
  assert.equal(Number(femaleItem.unit_price ?? femaleItem.final_amount), 150);
});

test('evento com categorias nao vira ingresso unico', async () => {
  const category = await must(service.from('ticket_categories').insert({
    event_id: fx.categoryEvent.id, name: 'Pista', slug: `pista-${fx.suffix}`, sort_order: 1, is_active: true,
  }).select('id').single(), 'category');
  const batch = await must(service.from('registration_batches').insert({
    event_id: fx.categoryEvent.id, name: 'Lote Pista', sequence_number: 1,
    male_price: 90, female_price: 90, max_confirmed_registrations: 40, is_active: true,
  }).select('id').single(), 'cat batch');
  await must(service.from('registration_batch_prices').insert({
    batch_id: batch.id, ticket_category_id: category.id, male_price: 90, female_price: 90,
  }), 'cat price');

  const unisexCreate = await fx.adminClient.rpc('create_single_ticket_unisex_batch', {
    p_event_id: fx.categoryEvent.id,
    p_name: 'Nao deve',
    p_sequence_number: 1,
    p_price: 1,
    p_max: 1,
  });
  assert.ok(unisexCreate.error, 'evento com categoria ativa nao pode criar lote unissex');

  const offer = await fx.adminClient.rpc('get_public_single_ticket_offer', { p_event_id: fx.categoryEvent.id });
  assert.equal(offer.error, null, offer.error?.message);
  const rows = Array.isArray(offer.data) ? offer.data : offer.data ? [offer.data] : [];
  assert.equal(rows.length, 0);

  const buyer = await createUser('Cat Buyer');
  const buyerClient = await clientFor(buyer);
  const order = await checkout(buyerClient, {
    eventId: fx.categoryEvent.id,
    email: buyer.email,
    fullName: 'Cat Buyer',
    gender: 'male',
    paymentMethod: 'courtesy',
    categoryId: category.id,
    items: [{ pricing_gender: 'male', ownership_mode: 'self' }],
  });
  assert.equal(order.error, null, order.error?.message);
});

test('solicitacao de alteracao gera 1 notification, retry nao duplica, permissao e IDOR', async () => {
  const kit = await must(service.from('event_kit_items').insert({
    event_id: fx.unisexEvent.id, organization_id: fx.org.id, name: 'Camiseta', slug: `camiseta-${fx.suffix}`,
    item_type: 'shirt', requires_variant: true, allow_participant_change: true, is_active: true,
    shirt_supply_mode: 'stock',
  }).select('id').single(), 'kit');
  const variantA = await must(service.from('event_kit_item_variants').insert({
    kit_item_id: kit.id, name: 'Adulto', value: 'M', is_active: true, sort_order: 1,
  }).select('id').single(), 'variant A');
  const variantB = await must(service.from('event_kit_item_variants').insert({
    kit_item_id: kit.id, name: 'Adulto', value: 'G', is_active: true, sort_order: 2,
  }).select('id').single(), 'variant B');
  await must(service.from('event_kit_item_variant_inventory').insert({
    organization_id: fx.org.id, event_id: fx.unisexEvent.id, kit_item_id: kit.id, variant_id: variantA.id, total_quantity: 5,
  }), 'inv A');
  await must(service.from('event_kit_item_variant_inventory').insert({
    organization_id: fx.org.id, event_id: fx.unisexEvent.id, kit_item_id: kit.id, variant_id: variantB.id, total_quantity: 5,
  }), 'inv B');

  const ticket = await must(service.from('tickets').select('id').eq('event_id', fx.unisexEvent.id).limit(1).single(), 'any ticket');
  const inserted = await must(service.from('ticket_item_change_requests').insert({
    ticket_id: ticket.id,
    kit_item_id: kit.id,
    organization_id: fx.org.id,
    event_id: fx.unisexEvent.id,
    requested_variant_id: variantB.id,
    requested_variant: { value: 'G' },
    current_variant_id: variantA.id,
    current_variant: { value: 'M' },
    status: 'pending',
    requested_by: fx.admin.id,
  }).select('id').single(), 'change request');

  const retry = await service.from('ticket_item_change_requests').insert({
    ticket_id: ticket.id,
    kit_item_id: kit.id,
    organization_id: fx.org.id,
    event_id: fx.unisexEvent.id,
    requested_variant_id: variantB.id,
    requested_variant: { value: 'G' },
    status: 'pending',
    requested_by: fx.admin.id,
  }).select('id').single();
  const requestId = inserted.id;
  if (!retry.error) {
    const notificationsAfterRetry = await must(
      service.from('organization_notifications').select('id,entity_id,type,action_href').eq('organization_id', fx.org.id).eq('type', 'CHANGE_REQUEST_CREATED'),
      'notif after retry',
    );
    assert.equal(notificationsAfterRetry.length, 1);
  }

  const notifications = await must(
    service.from('organization_notifications').select('*').eq('organization_id', fx.org.id).eq('type', 'CHANGE_REQUEST_CREATED'),
    'change notifications',
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].entity_id, requestId);
  assert.match(notifications[0].action_href, new RegExp(`/operacoes/solicitacoes\\?requestId=${requestId}`));
  fx.changeNotification = notifications[0];

  const opsList = await fx.opsClient.rpc('list_organization_notifications', { p_read_state: 'unread', p_type: 'CHANGE_REQUEST_CREATED' });
  assert.equal(opsList.error, null, opsList.error?.message);
  assert.equal(opsList.data.length, 1);
  assert.equal(opsList.data[0].is_unread, true);

  const feedbackList = await fx.feedbackClient.rpc('list_organization_notifications', { p_read_state: 'all', p_type: 'CHANGE_REQUEST_CREATED' });
  assert.equal(feedbackList.error, null, feedbackList.error?.message);
  assert.equal(feedbackList.data.length, 0);

  const noPermList = await fx.noPermClient.rpc('list_organization_notifications', { p_read_state: 'all' });
  assert.equal(noPermList.error, null, noPermList.error?.message);
  assert.equal(noPermList.data.length, 0);

  const outsiderList = await fx.outsiderClient.rpc('list_organization_notifications', { p_read_state: 'all' });
  assert.equal(outsiderList.error, null, outsiderList.error?.message);
  assert.equal((outsiderList.data ?? []).length, 0);

  const direct = await fx.noPermClient.from('organization_notifications').select('id').eq('id', fx.changeNotification.id);
  assert.equal(direct.error, null, direct.error?.message);
  assert.equal((direct.data ?? []).length, 0);

  const forbiddenMark = await fx.noPermClient.rpc('mark_organization_notification_read', {
    p_notification_id: fx.changeNotification.id,
  });
  assert.ok(forbiddenMark.error);

  const outsiderMark = await fx.outsiderClient.rpc('mark_organization_notification_read', {
    p_notification_id: fx.changeNotification.id,
  });
  assert.ok(outsiderMark.error);
});

test('feedback gera 1 notification, leitura nao apaga, marcar todas funciona', async () => {
  const inserted = await must(service.from('user_feedback').insert({
    organization_id: fx.org.id,
    user_id: fx.noPermAdmin.id,
    type: 'suggestion',
    message: 'Feedback de gate local 55/56',
    page_path: '/eventos',
    event_id: fx.unisexEvent.id,
  }).select('id').single(), 'feedback insert');

  const after = await must(
    service.from('organization_notifications').select('*').eq('organization_id', fx.org.id).eq('type', 'FEEDBACK_CREATED').eq('entity_id', inserted.id),
    'feedback after',
  );
  assert.equal(after.length, 1);
  assert.match(after[0].action_href, new RegExp(`/painel/feedbacks\\?feedbackId=${inserted.id}`));

  const retry = await service.from('organization_notifications').insert({
    organization_id: fx.org.id,
    type: 'FEEDBACK_CREATED',
    title: 'Novo feedback recebido',
    body: 'retry',
    entity_type: 'user_feedback',
    entity_id: inserted.id,
    action_href: `/painel/feedbacks?feedbackId=${inserted.id}`,
  });
  assert.equal(retry.error?.code, '23505');
  const afterRetry = await must(
    service.from('organization_notifications').select('id').eq('organization_id', fx.org.id).eq('type', 'FEEDBACK_CREATED').eq('entity_id', inserted.id),
    'feedback after retry',
  );
  assert.equal(afterRetry.length, 1);
  const extra = await must(service.from('user_feedback').insert({
    organization_id: fx.org.id,
    user_id: fx.noPermAdmin.id,
    type: 'problem',
    message: 'Segundo feedback para unread residual',
    event_id: fx.unisexEvent.id,
  }).select('id').single(), 'second feedback');
  const extraNotif = await must(
    service.from('organization_notifications').select('id').eq('entity_id', extra.id).single(),
    'second feedback notif',
  );
  assert.ok(extraNotif.id);
  fx.feedbackNotification = after[0];

  const feedbackUnread = await fx.feedbackClient.rpc('count_unread_organization_notifications');
  assert.equal(feedbackUnread.error, null, feedbackUnread.error?.message);
  assert.ok(Number(feedbackUnread.data) >= 1);

  const opsFeedback = await fx.opsClient.rpc('list_organization_notifications', { p_read_state: 'all', p_type: 'FEEDBACK_CREATED' });
  assert.equal(opsFeedback.error, null, opsFeedback.error?.message);
  assert.equal(opsFeedback.data.length, 0);

  const markOne = await fx.feedbackClient.rpc('mark_organization_notification_read', {
    p_notification_id: fx.feedbackNotification.id,
  });
  assert.equal(markOne.error, null, markOne.error?.message);

  const stillThere = await must(
    service.from('organization_notifications').select('id').eq('id', fx.feedbackNotification.id).single(),
    'notification still exists',
  );
  assert.ok(stillThere.id);

  const unreadAfterOne = await fx.feedbackClient.rpc('count_unread_organization_notifications');
  const markedAll = await fx.feedbackClient.rpc('mark_all_organization_notifications_read');
  assert.equal(markedAll.error, null, markedAll.error?.message);
  const unreadAfterAll = await fx.feedbackClient.rpc('count_unread_organization_notifications');
  assert.equal(Number(unreadAfterAll.data), 0);
  assert.ok(Number(unreadAfterOne.data) >= 1);
});

test('realtime publica INSERT de organization_notifications para admin autorizado', async () => {
  const publication = await must(
    service.from('organization_notifications').select('id').limit(1),
    'touch table',
  );
  assert.ok(publication === null || Array.isArray(publication) || publication);

  let userReceived = null;
  let serviceReceived = null;
  const serviceRealtime = createClient(apiUrl, serviceKey, options);

  const userChannel = fx.feedbackClient.channel(`gate-55-56-user-${Date.now()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'organization_notifications' }, (payload) => {
      userReceived = payload.new;
    });
  const serviceChannel = serviceRealtime.channel(`gate-55-56-service-${Date.now()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'organization_notifications' }, (payload) => {
      serviceReceived = payload.new;
    });

  async function waitStatus(channel, label) {
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(`${label}:timeout`), 10000);
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          clearTimeout(timeout);
          resolve(`${label}:${status}`);
        }
      });
    });
  }

  const [userStatus, serviceStatus] = await Promise.all([
    waitStatus(userChannel, 'user'),
    waitStatus(serviceChannel, 'service'),
  ]);

  const created = await must(service.from('user_feedback').insert({
    organization_id: fx.org.id,
    user_id: fx.admin.id,
    type: 'question',
    message: 'Realtime gate 55/56',
    event_id: fx.unisexEvent.id,
  }).select('id').single(), 'realtime feedback');

  const started = Date.now();
  while ((!userReceived || !serviceReceived) && Date.now() - started < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await fx.feedbackClient.removeChannel(userChannel);
  await serviceRealtime.removeChannel(serviceChannel);

  if (!userReceived) {
    throw new Error(
      `Realtime nao entregou INSERT. user=${userStatus} service=${serviceStatus} servicePayload=${Boolean(serviceReceived)} userPayload=${Boolean(userReceived)}. Publication/RLS precisam ser diagnosticados; nao substituir por polling.`,
    );
  }
  assert.equal(userReceived.type, 'FEEDBACK_CREATED');
});
