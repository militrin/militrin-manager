import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const apiUrl = 'http://127.0.0.1:54321';
const localEnvironment = Object.fromEntries(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx.cmd supabase status -o env'], { encoding: 'utf8' })
  .split(/\r?\n/).flatMap((line) => { const match = line.match(/^([A-Z_]+)="?([^"\r\n]+)"?$/); return match ? [[match[1], match[2]]] : []; }));
const options = { auth: { persistSession: false, autoRefreshToken: false } };

test('backend trata zero, uma e múltiplas categorias com a mesma regra adaptativa', async () => {
  const service = createClient(apiUrl, localEnvironment.SERVICE_ROLE_KEY, options);
  const anon = createClient(apiUrl, localEnvironment.ANON_KEY, options);
  const suffix = Date.now();
  const email = `adaptive-${suffix}@example.test`;
  const created = await service.auth.admin.createUser({ email, password: 'Adaptive-local-123!', email_confirm: true });
  assert.equal(created.error, null, created.error?.message);
  const signedIn = await anon.auth.signInWithPassword({ email, password: 'Adaptive-local-123!' });
  assert.equal(signedIn.error, null, signedIn.error?.message);

  const organization = await service.from('organizations').insert({ name: 'Checkout Adaptativo', slug: `adaptive-${suffix}`, status: 'active' }).select('id').single();
  assert.equal(organization.error, null, organization.error?.message);
  let ownerRole = await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle();
  if (!ownerRole.data) ownerRole = await service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single();
  assert.equal(ownerRole.error, null, ownerRole.error?.message);
  assert.equal((await service.from('admin_users').insert({ user_id: created.data.user.id, role_id: ownerRole.data.id, is_active: true })).error, null);
  assert.equal((await service.from('organization_members').insert({ organization_id: organization.data.id, user_id: created.data.user.id, role_id: ownerRole.data.id, is_owner: true, is_active: true })).error, null);

  async function createEvent(label, { flatPriceConfirmed = true } = {}) {
    const event = await service.from('events').insert({ organization_id: organization.data.id, name: `Evento ${label}`, year: 2032,
      slug: `adaptive-${label}-${suffix}`, is_active: true, registration_enabled: true, starts_at: '2032-10-10T12:00:00Z', min_age: 0 }).select('id').single();
    assert.equal(event.error, null, event.error?.message);
    const batch = await service.from('registration_batches').insert({ event_id: event.data.id, name: 'Lote 1', sequence_number: 1,
      male_price: 120, female_price: 100, max_confirmed_registrations: 100, is_active: true, flat_price_confirmed: flatPriceConfirmed }).select('id').single();
    assert.equal(batch.error, null, batch.error?.message);
    return { eventId: event.data.id, batchId: batch.data.id };
  }

  async function addCategory(config, label, active = true) {
    const category = await service.from('ticket_categories').insert({ event_id: config.eventId, name: label,
      slug: `${label.toLowerCase().replace(/\W+/g, '-')}-${suffix}`, is_active: active }).select('id').single();
    assert.equal(category.error, null, category.error?.message);
    const price = await service.from('registration_batch_prices').insert({ batch_id: config.batchId, ticket_category_id: category.data.id,
      male_price: 120, female_price: 100 });
    assert.equal(price.error, null, price.error?.message);
    return category.data.id;
  }

  const categoryless = await createEvent('sem-categoria');
  const zeroPreview = await anon.rpc('get_registration_pricing_preview', { p_event_id: categoryless.eventId, p_ticket_category_id: null, p_gender: 'male' });
  assert.equal(zeroPreview.error, null, zeroPreview.error?.message);
  assert.equal(Number(zeroPreview.data[0].base_amount), 120);

  const checkout = await anon.rpc('create_multi_ticket_order_checkout', {
    p_event_id: categoryless.eventId, p_ticket_category_id: null, p_quantity: 1, p_gender: 'male', p_payment_method: 'courtesy',
    p_buyer_full_name: 'Comprador Adaptativo', p_buyer_cpf: '52998224725', p_buyer_birth_date: '1990-01-01', p_buyer_gender: 'male',
    p_buyer_phone: '11999990000', p_buyer_email: email, p_buyer_city: 'Sao Paulo', p_limit_per_order: 10,
    p_assign_first_to_buyer: true, p_client_request_id: `adaptive-zero-${suffix}`, p_items: [{ pricing_gender: 'male', ownership_mode: 'self' }],
  });
  assert.equal(checkout.error, null, checkout.error?.message);
  const categorylessItem = await service.from('order_items').select('ticket_category_id,batch_id').eq('order_id', checkout.data[0].order_id).single();
  assert.equal(categorylessItem.error, null, categorylessItem.error?.message);
  assert.equal(categorylessItem.data.ticket_category_id, null);
  assert.equal(categorylessItem.data.batch_id, categoryless.batchId);

  const unique = await createEvent('uma-categoria');
  const uniqueCategoryId = await addCategory(unique, 'Geral');
  const missingUnique = await anon.rpc('get_registration_pricing_preview', { p_event_id: unique.eventId, p_ticket_category_id: null, p_gender: 'male' });
  assert.ok(missingUnique.error);
  assert.match(missingUnique.error.message, /TICKET_CATEGORY_REQUIRED/);
  const uniquePreview = await anon.rpc('get_registration_pricing_preview', { p_event_id: unique.eventId, p_ticket_category_id: uniqueCategoryId, p_gender: 'male' });
  assert.equal(uniquePreview.error, null, uniquePreview.error?.message);
  const uniqueCheckout = await anon.rpc('create_multi_ticket_order_checkout', {
    p_event_id: unique.eventId, p_ticket_category_id: uniqueCategoryId, p_quantity: 1, p_gender: 'male', p_payment_method: 'courtesy',
    p_buyer_full_name: 'Comprador Adaptativo', p_buyer_cpf: '52998224725', p_buyer_birth_date: '1990-01-01', p_buyer_gender: 'male',
    p_buyer_phone: '11999990000', p_buyer_email: email, p_buyer_city: 'Sao Paulo', p_limit_per_order: 10,
    p_assign_first_to_buyer: true, p_client_request_id: `adaptive-one-${suffix}`, p_items: [{ pricing_gender: 'male', ownership_mode: 'self' }],
  });
  assert.equal(uniqueCheckout.error, null, uniqueCheckout.error?.message);
  const categorizedItem = await service.from('order_items').select('ticket_category_id').eq('order_id', uniqueCheckout.data[0].order_id).single();
  assert.equal(categorizedItem.error, null, categorizedItem.error?.message);
  assert.equal(categorizedItem.data.ticket_category_id, uniqueCategoryId);

  const multiple = await createEvent('multiplas-categorias');
  await addCategory(multiple, 'Open Bar');
  await addCategory(multiple, 'Sem Open Bar');
  const missingMultiple = await anon.rpc('get_registration_pricing_preview', { p_event_id: multiple.eventId, p_ticket_category_id: null, p_gender: 'female' });
  assert.ok(missingMultiple.error);
  assert.match(missingMultiple.error.message, /TICKET_CATEGORY_REQUIRED/);

  const disabled = await createEvent('categoria-inativa');
  await addCategory(disabled, 'Inativa', false);
  const inactivePreview = await anon.rpc('get_registration_pricing_preview', { p_event_id: disabled.eventId, p_ticket_category_id: null, p_gender: 'female' });
  assert.ok(inactivePreview.error, 'categoria existente porem indisponivel nao pode virar "ingresso unico" com preco de lote');
  assert.match(inactivePreview.error.message, /TICKET_CATEGORY_UNAVAILABLE/);

  const unconfirmed = await createEvent('preco-nao-confirmado', { flatPriceConfirmed: false });
  const unconfirmedPreview = await anon.rpc('get_registration_pricing_preview', { p_event_id: unconfirmed.eventId, p_ticket_category_id: null, p_gender: 'male' });
  assert.ok(unconfirmedPreview.error, 'lote sem preco de ingresso unico confirmado nunca pode retornar preco final zero silenciosamente');
  assert.match(unconfirmedPreview.error.message, /BATCH_FLAT_PRICE_NOT_CONFIRMED/);

  const unconfirmedCheckout = await anon.rpc('create_multi_ticket_order_checkout', {
    p_event_id: unconfirmed.eventId, p_ticket_category_id: null, p_quantity: 1, p_gender: 'male', p_payment_method: 'pix',
    p_buyer_full_name: 'Comprador Nao Confirmado', p_buyer_cpf: '52998224725', p_buyer_birth_date: '1990-01-01', p_buyer_gender: 'male',
    p_buyer_phone: '11999990000', p_buyer_email: email, p_buyer_city: 'Sao Paulo', p_limit_per_order: 10,
    p_assign_first_to_buyer: true, p_client_request_id: `adaptive-unconfirmed-${suffix}`, p_items: [{ pricing_gender: 'male', ownership_mode: 'self' }],
  });
  assert.ok(unconfirmedCheckout.error, 'pedido nao pode ser criado com preco de ingresso unico nao confirmado');
  assert.match(unconfirmedCheckout.error.message, /BATCH_FLAT_PRICE_NOT_CONFIRMED/);
  const unconfirmedOrderCount = await service.from('orders').select('id', { count: 'exact', head: true }).eq('event_id', unconfirmed.eventId);
  assert.equal(unconfirmedOrderCount.count, 0, 'nenhum pedido deve ser persistido quando o preco nao foi confirmado');

  const confirmResult = await anon.rpc('confirm_registration_batch_flat_price', {
    p_batch_id: unconfirmed.batchId, p_event_id: unconfirmed.eventId, p_male_price: 150, p_female_price: 130, p_reason: 'teste automatizado',
  });
  assert.equal(confirmResult.error, null, confirmResult.error?.message);
  const confirmedPreview = await anon.rpc('get_registration_pricing_preview', { p_event_id: unconfirmed.eventId, p_ticket_category_id: null, p_gender: 'male' });
  assert.equal(confirmedPreview.error, null, confirmedPreview.error?.message);
  assert.equal(Number(confirmedPreview.data[0].base_amount), 150);

  await service.auth.admin.deleteUser(created.data.user.id);
});
