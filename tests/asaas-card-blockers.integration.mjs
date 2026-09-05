import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

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
  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }
  async function clientFor(email, password) {
    const client = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`login ${email}: ${signIn.error.message}`);
    return client;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const password = 'SenhaForte!123';
  const org = await must(service.from('organizations').insert({ name: 'Card Blockers', slug: `card-blk-${suffix}` }).select('id').single(), 'org');
  const buyerEmail = `card-blk-buyer-${suffix}@qa.local`;
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'buyer');
  await must(service.from('customer_profiles').upsert({
    user_id: buyerCreated.user.id, cpf: generateValidCpf(), full_name: 'Buyer Card',
    birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male',
  }, { onConflict: 'user_id' }), 'buyer profile');
  await resolveOrCreateAdminRole(service, 'owner', 'Owner');

  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Card Blockers', year: 2026, slug: `card-blk-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 80, female_price: 80,
    max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({
    event_id: event.id, name: 'Geral', slug: `geral-blk-${suffix}`, sort_order: 1, is_active: true,
  }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({
    batch_id: batch.id, ticket_category_id: category.id, male_price: 80, female_price: 80,
  }), 'price');

  const buyer = await clientFor(buyerEmail, password);

  async function createOrder() {
    const result = await must(buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: category.id, p_gender: 'male', p_quantity: 1,
      p_payment_method: 'pix', p_buyer_full_name: 'Buyer Card', p_buyer_cpf: generateValidCpf(),
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_items: [{ ownership_mode: 'self' }], p_client_request_id: `card-blk-${Date.now()}-${Math.random()}`,
    }), 'create order');
    const row = Array.isArray(result) ? result[0] : result;
    return row.order_id;
  }

  async function ticketCount(orderId) {
    const { data } = await service.from('tickets').select('id').eq('order_id', orderId);
    return (data ?? []).length;
  }

  async function paymentRow(orderId) {
    const { data } = await service.from('payments').select('*').eq('order_id', orderId).single();
    return data;
  }

  return { service, must, buyer, org, event, suffix, createOrder, ticketCount, paymentRow };
}

const fx = await buildFixture();

test('cartao 2x: 1 order, 1 payment, installment, 2 charges, 1 ticket, sem divergencia', async () => {
  const orderId = await fx.createOrder();
  const pay1 = `pay_2x_a_${fx.suffix}`;
  const pay2 = `pay_2x_b_${fx.suffix}`;
  const installmentId = `inst_2x_${fx.suffix}`;

  await fx.must(fx.buyer.rpc('start_order_payment_pix', {
    p_order_id: orderId,
    p_pix_code: '',
    p_pix_qrcode: '',
    p_gateway_payment_id: pay1,
    p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    p_provider: 'asaas',
    p_gateway_account_key: 'conta-card',
    p_payment_method: 'credit_card',
    p_checkout_url: 'https://sandbox.asaas.com/i/pay_2x',
    p_gateway_installment_id: installmentId,
    p_gateway_charges: [
      { gateway_payment_id: pay1, gateway_installment_id: installmentId, installment_number: 1, installment_count: 2, amount: 40 },
      { gateway_payment_id: pay2, gateway_installment_id: installmentId, installment_number: 2, installment_count: 2, amount: 40 },
    ],
  }), 'start 2x');

  const payment = await fx.paymentRow(orderId);
  assert.equal(payment.gateway_installment_id, installmentId);
  const { data: charges } = await fx.service.from('payment_gateway_charges').select('*').eq('payment_id', payment.id);
  assert.equal(charges.length, 2);

  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas',
    p_provider_payment_id: pay1,
    p_provider_status: 'CONFIRMED',
    p_internal_status: 'paid',
    p_expected_gateway_account_key: 'conta-card',
    p_event_type: 'PAYMENT_CONFIRMED',
  }), 'parcela 1');

  assert.equal(await fx.ticketCount(orderId), 1);
  assert.equal((await fx.paymentRow(orderId)).payment_status, 'paid');

  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas',
    p_provider_payment_id: pay2,
    p_provider_status: 'CONFIRMED',
    p_internal_status: 'paid',
    p_expected_gateway_account_key: 'conta-card',
    p_event_type: 'PAYMENT_CONFIRMED',
  }), 'parcela 2');

  assert.equal(await fx.ticketCount(orderId), 1);
  const { data: charge2 } = await fx.service.from('payment_gateway_charges').select('gateway_status').eq('gateway_payment_id', pay2).single();
  assert.equal(charge2.gateway_status, 'CONFIRMED');
});

test('CAPTURE_REFUSED com PENDING nao falha o payment; CONFIRMED posterior emite 1 ticket', async () => {
  const orderId = await fx.createOrder();
  const payId = `pay_refused_${fx.suffix}`;
  await fx.must(fx.buyer.rpc('start_order_payment_pix', {
    p_order_id: orderId,
    p_pix_code: '',
    p_pix_qrcode: '',
    p_gateway_payment_id: payId,
    p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    p_provider: 'asaas',
    p_gateway_account_key: 'conta-card',
    p_payment_method: 'credit_card',
    p_checkout_url: 'https://sandbox.asaas.com/i/pay_refused',
  }), 'start refused');

  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas',
    p_provider_payment_id: payId,
    p_provider_status: 'PENDING',
    p_internal_status: 'pending',
    p_expected_gateway_account_key: 'conta-card',
    p_event_type: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
  }), 'capture refused');

  const afterRefuse = await fx.paymentRow(orderId);
  assert.equal(afterRefuse.payment_status, 'pending');
  assert.equal(afterRefuse.last_gateway_attempt_status, 'refused');
  assert.equal(await fx.ticketCount(orderId), 0);

  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas',
    p_provider_payment_id: payId,
    p_provider_status: 'CONFIRMED',
    p_internal_status: 'paid',
    p_expected_gateway_account_key: 'conta-card',
    p_event_type: 'PAYMENT_CONFIRMED',
  }), 'approved after refuse');

  const afterPaid = await fx.paymentRow(orderId);
  assert.equal(afterPaid.payment_status, 'paid');
  assert.equal(afterPaid.last_gateway_attempt_status, null);
  assert.equal(await fx.ticketCount(orderId), 1);
});

test('mesmo pay_ em contas diferentes nao viola unique', async () => {
  const shared = `pay_shared_ok_${fx.suffix}`;
  await fx.must(fx.service.from('payments').insert({
    organization_id: fx.org.id, event_id: fx.event.id, amount: 10, final_amount: 10,
    payment_status: 'pending', payment_method: 'pix', provider: 'asaas',
    gateway_payment_id: shared, gateway_account_key: 'conta-pix',
  }).select('id').single(), 'pix pay');
  await fx.must(fx.service.from('payments').insert({
    organization_id: fx.org.id, event_id: fx.event.id, amount: 10, final_amount: 10,
    payment_status: 'pending', payment_method: 'credit_card', provider: 'asaas',
    gateway_payment_id: shared, gateway_account_key: 'conta-card',
  }).select('id').single(), 'card pay');
});

test('webhook da parcela 2 com conta errada e mismatch, nao divergencia orfa', async () => {
  const orderId = await fx.createOrder();
  const pay1 = `pay_mm_a_${fx.suffix}`;
  const pay2 = `pay_mm_b_${fx.suffix}`;
  await fx.must(fx.buyer.rpc('start_order_payment_pix', {
    p_order_id: orderId,
    p_pix_code: '',
    p_pix_qrcode: '',
    p_gateway_payment_id: pay1,
    p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    p_provider: 'asaas',
    p_gateway_account_key: 'conta-card',
    p_payment_method: 'credit_card',
    p_checkout_url: 'https://sandbox.asaas.com/i/mm',
    p_gateway_installment_id: `inst_mm_${fx.suffix}`,
    p_gateway_charges: [
      { gateway_payment_id: pay1, installment_number: 1, installment_count: 2, amount: 40 },
      { gateway_payment_id: pay2, installment_number: 2, installment_count: 2, amount: 40 },
    ],
  }), 'start mismatch 2x');

  const mismatch = await fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas',
    p_provider_payment_id: pay2,
    p_provider_status: 'CONFIRMED',
    p_internal_status: 'paid',
    p_expected_gateway_account_key: 'conta-pix',
    p_event_type: 'PAYMENT_CONFIRMED',
  });
  assert.equal(mismatch.error?.message, 'GATEWAY_ACCOUNT_MISMATCH');
  assert.equal((await fx.paymentRow(orderId)).payment_status, 'pending');
  assert.equal(await fx.ticketCount(orderId), 0);
});

test('cobranca deletada nao e reutilizada no claim', async () => {
  const orderId = await fx.createOrder();
  const payId = `pay_del_${fx.suffix}`;
  await fx.must(fx.buyer.rpc('start_order_payment_pix', {
    p_order_id: orderId,
    p_pix_code: 'PIX-DEL',
    p_pix_qrcode: 'data:image/svg+xml;utf8,del',
    p_gateway_payment_id: payId,
    p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    p_provider: 'asaas',
    p_gateway_account_key: 'conta-pix',
    p_payment_method: 'pix',
  }), 'start pix del');

  const live = await fx.must(fx.buyer.rpc('claim_order_pix_generation', { p_order_id: orderId }), 'claim live');
  assert.equal(live.action, 'reuse');

  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas',
    p_provider_payment_id: payId,
    p_provider_status: 'PENDING',
    p_internal_status: 'pending',
    p_expected_gateway_account_key: 'conta-pix',
    p_event_type: 'PAYMENT_DELETED',
  }), 'deleted');

  const afterDelete = await fx.must(fx.buyer.rpc('claim_order_pix_generation', { p_order_id: orderId }), 'claim deleted');
  assert.equal(afterDelete.action, 'claim');
  const { data: charge } = await fx.service.from('payment_gateway_charges').select('reusable, deleted').eq('gateway_payment_id', payId).single();
  assert.equal(charge.reusable, false);
  assert.equal(charge.deleted, true);
});

test('webhook duplicado na mesma conta nao cria segundo evento', async () => {
  const eventId = `evt_dup_${fx.suffix}`;
  const first = await fx.must(fx.service.rpc('record_payment_gateway_event', {
    p_provider: 'asaas', p_external_event_id: eventId, p_event_type: 'PAYMENT_CONFIRMED',
    p_provider_payment_id: 'pay_dup', p_payload: { id: eventId }, p_gateway_account_key: 'conta-card',
  }), 'first evt');
  const dup = await fx.must(fx.service.rpc('record_payment_gateway_event', {
    p_provider: 'asaas', p_external_event_id: eventId, p_event_type: 'PAYMENT_CONFIRMED',
    p_provider_payment_id: 'pay_dup', p_payload: { id: eventId }, p_gateway_account_key: 'conta-card',
  }), 'dup evt');
  const firstRow = Array.isArray(first) ? first[0] : first;
  const dupRow = Array.isArray(dup) ? dup[0] : dup;
  assert.equal(firstRow.is_new, true);
  assert.equal(dupRow.is_new, false);
  assert.equal(dupRow.id, firstRow.id);
});
