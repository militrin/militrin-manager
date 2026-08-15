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

  // Categoria desativada (nunca esteve ativa neste teste) libera o fluxo de
  // ingresso unico -- mas ainda exige confirmacao consciente do preco.
  const disabled = await createEvent('categoria-inativa', { flatPriceConfirmed: false });
  await addCategory(disabled, 'Inativa', false);
  const inactivePreview = await anon.rpc('get_registration_pricing_preview', { p_event_id: disabled.eventId, p_ticket_category_id: null, p_gender: 'female' });
  assert.ok(inactivePreview.error, 'sem categoria ativa, o evento cai no fluxo de ingresso unico, que exige confirmacao');
  assert.match(inactivePreview.error.message, /BATCH_FLAT_PRICE_NOT_CONFIRMED/);

  // === Experiencia administrativa: evento sem categoria + preco nao configurado ===
  const unconfirmed = await createEvent('preco-nao-confirmado', { flatPriceConfirmed: false });
  const unconfirmedStatus = await anon.rpc('get_event_single_ticket_price_status', { p_event_id: unconfirmed.eventId });
  assert.equal(unconfirmedStatus.error, null, unconfirmedStatus.error?.message);
  assert.equal(unconfirmedStatus.data[0].active_category_count, 0);
  assert.equal(unconfirmedStatus.data[0].price_confirmed, false);
  assert.equal(unconfirmedStatus.data[0].registration_enabled, true);

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

  // Admin configura o preco pelo fluxo canonico (unico caminho, sem RPC manual do operador).
  const setPriceResult = await anon.rpc('set_event_single_ticket_price', {
    p_event_id: unconfirmed.eventId, p_male_price: 150, p_female_price: 130,
  });
  assert.equal(setPriceResult.error, null, setPriceResult.error?.message);
  const confirmedStatus = await anon.rpc('get_event_single_ticket_price_status', { p_event_id: unconfirmed.eventId });
  assert.equal(confirmedStatus.data[0].price_confirmed, true);
  assert.equal(Number(confirmedStatus.data[0].male_price), 150);
  const confirmedPreview = await anon.rpc('get_registration_pricing_preview', { p_event_id: unconfirmed.eventId, p_ticket_category_id: null, p_gender: 'male' });
  assert.equal(confirmedPreview.error, null, confirmedPreview.error?.message);
  assert.equal(Number(confirmedPreview.data[0].base_amount), 150);

  const confirmedCheckout = await anon.rpc('create_multi_ticket_order_checkout', {
    p_event_id: unconfirmed.eventId, p_ticket_category_id: null, p_quantity: 1, p_gender: 'male', p_payment_method: 'pix',
    p_buyer_full_name: 'Comprador Confirmado', p_buyer_cpf: '52998224725', p_buyer_birth_date: '1990-01-01', p_buyer_gender: 'male',
    p_buyer_phone: '11999990000', p_buyer_email: email, p_buyer_city: 'Sao Paulo', p_limit_per_order: 10,
    p_assign_first_to_buyer: true, p_client_request_id: `adaptive-confirmed-${suffix}`, p_items: [{ pricing_gender: 'male', ownership_mode: 'self' }],
  });
  assert.equal(confirmedCheckout.error, null, confirmedCheckout.error?.message);
  // O preco exibido no resumo (preview) e exatamente o persistido no pedido.
  assert.equal(Number(confirmedCheckout.data[0].amount), 150);
  assert.equal(Number(confirmedCheckout.data[0].final_amount), 150);
  const confirmedPayment = await service.from('payments').select('payment_method,final_amount').eq('id', confirmedCheckout.data[0].payment_id).single();
  assert.notEqual(confirmedPayment.data.payment_method, 'courtesy', 'pedido pago nao pode ser rotulado como cortesia');

  // === set_event_single_ticket_price cria o lote quando o evento nunca teve nenhum ===
  const brandNewEvent = await service.from('events').insert({ organization_id: organization.data.id, name: 'Evento Novo Sem Lote', year: 2032,
    slug: `adaptive-novo-${suffix}`, is_active: true, registration_enabled: true, starts_at: '2032-10-10T12:00:00Z', min_age: 0 }).select('id').single();
  assert.equal(brandNewEvent.error, null, brandNewEvent.error?.message);
  const noBatchYet = await service.from('registration_batches').select('id').eq('event_id', brandNewEvent.data.id);
  assert.equal(noBatchYet.data.length, 0, 'evento novo sem categoria nao deveria ter lote algum ainda');
  const createBatchResult = await anon.rpc('set_event_single_ticket_price', { p_event_id: brandNewEvent.data.id, p_male_price: 80, p_female_price: 70 });
  assert.equal(createBatchResult.error, null, createBatchResult.error?.message);
  const createdBatch = await service.from('registration_batches').select('id,is_active,flat_price_confirmed').eq('event_id', brandNewEvent.data.id).single();
  assert.equal(createdBatch.data.is_active, true);
  assert.equal(createdBatch.data.flat_price_confirmed, true);

  // === preco zero explicitamente salvo e um ingresso gratuito legitimo ===
  const freeEvent = await createEvent('gratuito-deliberado', { flatPriceConfirmed: false });
  const setFreePriceResult = await anon.rpc('set_event_single_ticket_price', { p_event_id: freeEvent.eventId, p_male_price: 0, p_female_price: 0 });
  assert.equal(setFreePriceResult.error, null, setFreePriceResult.error?.message);
  const freeCheckout = await anon.rpc('create_multi_ticket_order_checkout', {
    p_event_id: freeEvent.eventId, p_ticket_category_id: null, p_quantity: 1, p_gender: 'female', p_payment_method: 'pix',
    p_buyer_full_name: 'Comprador Gratuito', p_buyer_cpf: '52998224725', p_buyer_birth_date: '1990-01-01', p_buyer_gender: 'female',
    p_buyer_phone: '11999990000', p_buyer_email: email, p_buyer_city: 'Sao Paulo', p_limit_per_order: 10,
    p_assign_first_to_buyer: true, p_client_request_id: `adaptive-free-${suffix}`, p_items: [{ pricing_gender: 'female', ownership_mode: 'self' }],
  });
  assert.equal(freeCheckout.error, null, freeCheckout.error?.message);
  assert.equal(Number(freeCheckout.data[0].amount), 0);
  assert.equal(Number(freeCheckout.data[0].final_amount), 0);
  const freePayment = await service.from('payments').select('payment_method,payment_status,amount,discount_amount,final_amount').eq('id', freeCheckout.data[0].payment_id).single();
  assert.equal(freePayment.data.payment_status, 'paid');
  assert.notEqual(freePayment.data.payment_method, 'courtesy', 'gratuito deliberado nao e a mesma coisa que cortesia administrativa');
  assert.equal(Number(freePayment.data.amount), 0);
  assert.equal(Number(freePayment.data.discount_amount), 0);

  // === criar categoria depois faz o preco da categoria assumir, mesmo com preco unico confirmado ===
  const laterCategoryEvent = await createEvent('categoria-depois', { flatPriceConfirmed: true });
  const laterCategoryPreviewBefore = await anon.rpc('get_registration_pricing_preview', { p_event_id: laterCategoryEvent.eventId, p_ticket_category_id: null, p_gender: 'male' });
  assert.equal(laterCategoryPreviewBefore.error, null, laterCategoryPreviewBefore.error?.message);
  assert.equal(Number(laterCategoryPreviewBefore.data[0].base_amount), 120);

  const newCategoryId = await addCategory(laterCategoryEvent, 'Categoria Nova');
  const laterCategoryPreviewAfter = await anon.rpc('get_registration_pricing_preview', { p_event_id: laterCategoryEvent.eventId, p_ticket_category_id: null, p_gender: 'male' });
  assert.ok(laterCategoryPreviewAfter.error, 'com categoria ativa, o ingresso unico nao pode mais ser usado');
  assert.match(laterCategoryPreviewAfter.error.message, /TICKET_CATEGORY_REQUIRED/);
  const laterCategoryPreviewByCategory = await anon.rpc('get_registration_pricing_preview', { p_event_id: laterCategoryEvent.eventId, p_ticket_category_id: newCategoryId, p_gender: 'male' });
  assert.equal(laterCategoryPreviewByCategory.error, null, laterCategoryPreviewByCategory.error?.message);
  assert.equal(Number(laterCategoryPreviewByCategory.data[0].base_amount), 120, 'preco vem da categoria, nao mais do lote');

  // === remover/desativar todas as categorias exige nova confirmacao, mesmo que o numero antigo continue igual ===
  const deactivateResult = await service.from('ticket_categories').update({ is_active: false }).eq('id', newCategoryId);
  assert.equal(deactivateResult.error, null, deactivateResult.error?.message);
  const afterDeactivatePreview = await anon.rpc('get_registration_pricing_preview', { p_event_id: laterCategoryEvent.eventId, p_ticket_category_id: null, p_gender: 'male' });
  assert.ok(afterDeactivatePreview.error, 'confirmacao antiga do preco unico fica obsoleta assim que uma categoria ativa existiu');
  assert.match(afterDeactivatePreview.error.message, /BATCH_FLAT_PRICE_NOT_CONFIRMED/);
  const afterDeactivateStatus = await anon.rpc('get_event_single_ticket_price_status', { p_event_id: laterCategoryEvent.eventId });
  assert.equal(afterDeactivateStatus.data[0].price_confirmed, false, 'a UI deve voltar a mostrar o aviso de preco nao configurado');

  // === duplicar evento nunca herda a confirmacao do preco unico ===
  const duplicateResult = await anon.rpc('duplicate_event_configuration', {
    p_source_event_id: unconfirmed.eventId, p_target_name: `Duplicado ${suffix}`, p_target_slug: `adaptive-duplicado-${suffix}`, p_target_year: 2032,
    p_copy_categories: true, p_copy_kit_items: false, p_copy_benefits: false, p_copy_batches: true, p_copy_batch_prices: true,
    p_copy_inventory_structure: false, p_copy_coupons: false,
  });
  assert.equal(duplicateResult.error, null, duplicateResult.error?.message);
  const duplicatedBatch = await service.from('registration_batches').select('flat_price_confirmed,male_price,female_price').eq('event_id', duplicateResult.data).single();
  assert.equal(duplicatedBatch.data.flat_price_confirmed, false, 'evento duplicado nunca pode herdar preco de ingresso unico ja confirmado');

  await service.auth.admin.deleteUser(created.data.user.id);
});
