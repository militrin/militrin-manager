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
  const anonymous = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

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
  const org = await must(service.from('organizations').insert({ name: 'PIX Claim Test', slug: `pix-claim-${suffix}` }).select('id').single(), 'org');
  const buyerEmail = `pix-claim-buyer-${suffix}@qa.local`;
  const otherEmail = `pix-claim-other-${suffix}@qa.local`;
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'buyer');
  const otherCreated = await must(service.auth.admin.createUser({ email: otherEmail, password, email_confirm: true }), 'other');
  await must(service.from('customer_profiles').upsert({ user_id: buyerCreated.user.id, cpf: generateValidCpf(), full_name: 'Buyer Claim', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');
  await must(service.from('customer_profiles').upsert({ user_id: otherCreated.user.id, cpf: generateValidCpf(), full_name: 'Other Claim', birth_date: '1991-01-01', phone: '11999990002', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'other profile');

  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento PIX Claim', year: 2026, slug: `pix-claim-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 90, female_price: 90, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-claim-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 90, female_price: 90 }), 'price');

  const buyer = await clientFor(buyerEmail, password);
  const other = await clientFor(otherEmail, password);
  await resolveOrCreateAdminRole(service, 'owner', 'Owner');

  async function createOrder(client, email) {
    const result = await must(client.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: category.id, p_gender: 'male', p_quantity: 1,
      p_payment_method: 'pix', p_buyer_full_name: 'Buyer Claim', p_buyer_cpf: generateValidCpf(),
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: email, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_items: [{ ownership_mode: 'self' }], p_client_request_id: `pix-claim-${Date.now()}-${Math.random()}`,
    }), 'create order');
    const row = Array.isArray(result) ? result[0] : result;
    return row.order_id;
  }

  return { service, must, anonymous, buyer, other, org, event, createOrder, buyerEmail, otherEmail, suffix };
}

const fx = await buildFixture();

test('PIX valido existente e reutilizado', async () => {
  const orderId = await fx.createOrder(fx.buyer, fx.buyerEmail);
  await fx.must(fx.buyer.rpc('start_order_payment_pix', {
    p_order_id: orderId,
    p_pix_code: 'LIVE-PIX',
    p_pix_qrcode: 'data:image/svg+xml;utf8,live',
    p_gateway_payment_id: `live-${fx.suffix}`,
    p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    p_provider: 'fake',
    p_gateway_account_key: 'militrin-temp',
  }), 'start live pix');

  const claim = await fx.must(fx.buyer.rpc('claim_order_pix_generation', { p_order_id: orderId }), 'claim reuse');
  assert.equal(claim.action, 'reuse');
});

test('dois claims simultaneos: no maximo um cria cobranca nova', async () => {
  const orderId = await fx.createOrder(fx.buyer, fx.buyerEmail);
  const [a, b] = await Promise.all([
    fx.buyer.rpc('claim_order_pix_generation', { p_order_id: orderId }),
    fx.buyer.rpc('claim_order_pix_generation', { p_order_id: orderId }),
  ]);
  const results = [a, b];
  const claims = results.filter((result) => !result.error && result.data?.action === 'claim');
  const blocked = results.filter((result) => String(result.error?.message ?? '').includes('PIX_GENERATION_IN_PROGRESS'));
  assert.equal(claims.length, 1, 'apenas um claim efetivo');
  assert.equal(blocked.length, 1, 'o segundo request e bloqueado');
});

test('claim abandonado apos timeout pode ser recuperado', async () => {
  const orderId = await fx.createOrder(fx.buyer, fx.buyerEmail);
  await fx.must(fx.buyer.rpc('claim_order_pix_generation', { p_order_id: orderId }), 'claim inicial');
  await fx.must(fx.service.from('payments').update({
    pix_generation_started_at: new Date(Date.now() - 50_000).toISOString(),
  }).eq('order_id', orderId), 'envelhece claim');
  const again = await fx.must(fx.buyer.rpc('claim_order_pix_generation', { p_order_id: orderId }), 'claim apos timeout');
  assert.equal(again.action, 'claim');
});

test('release libera a trava para retry seguro antes de criar no gateway', async () => {
  const orderId = await fx.createOrder(fx.buyer, fx.buyerEmail);
  await fx.must(fx.buyer.rpc('claim_order_pix_generation', { p_order_id: orderId }), 'claim');
  await fx.must(fx.buyer.rpc('release_order_pix_generation', { p_order_id: orderId }), 'release');
  const again = await fx.must(fx.buyer.rpc('claim_order_pix_generation', { p_order_id: orderId }), 'claim apos release');
  assert.equal(again.action, 'claim');
});

test('anon e comprador B nao iniciam PIX do pedido A', async () => {
  const orderId = await fx.createOrder(fx.buyer, fx.buyerEmail);
  assert.ok((await fx.anonymous.rpc('claim_order_pix_generation', { p_order_id: orderId })).error);
  assert.ok((await fx.other.rpc('claim_order_pix_generation', { p_order_id: orderId })).error);
});

test('account key e persistida e nao reinterpreta cobranca antiga sem rotulo', async () => {
  const orderId = await fx.createOrder(fx.buyer, fx.buyerEmail);
  await fx.must(fx.buyer.rpc('start_order_payment_pix', {
    p_order_id: orderId,
    p_pix_code: 'KEY-PIX',
    p_pix_qrcode: 'data:image/svg+xml;utf8,key',
    p_gateway_payment_id: `key-${fx.suffix}`,
    p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    p_provider: 'asaas',
    p_gateway_account_key: 'militrin-temp',
  }), 'start with key');
  const { data: stored } = await fx.service.from('payments').select('gateway_account_key').eq('order_id', orderId).single();
  assert.equal(stored.gateway_account_key, 'militrin-temp');

  const rejected = await fx.buyer.rpc('start_order_payment_pix', {
    p_order_id: orderId,
    p_pix_code: 'BAD',
    p_pix_qrcode: 'data:image/svg+xml;utf8,bad',
    p_gateway_payment_id: `bad-${fx.suffix}`,
    p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    p_provider: 'asaas',
    p_gateway_account_key: '$aact_ThisLooksLikeAnApiKey',
  });
  assert.ok(rejected.error, 'API key nao pode ser gravada como account key');

  const legacyId = `legacy-${fx.suffix}`;
  await fx.must(fx.service.from('payments').insert({
    organization_id: fx.org.id, event_id: fx.event.id, amount: 10, final_amount: 10,
    payment_status: 'pending', payment_method: 'pix', provider: 'asaas', gateway_payment_id: legacyId,
  }).select('id').single(), 'legacy payment');
  const { data: legacy } = await fx.service.from('payments').select('gateway_account_key').eq('gateway_payment_id', legacyId).single();
  assert.equal(legacy.gateway_account_key, null);
});
