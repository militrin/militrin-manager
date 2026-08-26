// Fase 2 Asaas -- PIX sandbox: get_order_payer_details (RPC nova, migration
// 20260901000000) e a fonte de dados do pagador que generatePublicOrderPixAction
// usa para chamar PaymentGatewayProvider.createPixPayment(...). Roda contra o
// Supabase local (`supabase start`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

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
  const org = await must(service.from('organizations').insert({ name: 'Payer Details Test', slug: `payer-${suffix}` }).select('id').single(), 'org');

  const buyerEmail = `payer-buyer-${suffix}@qa.local`;
  const outsiderEmail = `payer-outsider-${suffix}@qa.local`;
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'create buyer');
  const outsiderCreated = await must(service.auth.admin.createUser({ email: outsiderEmail, password, email_confirm: true }), 'create outsider');
  const buyerCpf = generateValidCpf();
  await must(service.from('customer_profiles').upsert({
    user_id: buyerCreated.user.id, cpf: buyerCpf, full_name: 'Comprador Teste', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male',
  }, { onConflict: 'user_id' }), 'buyer profile');
  await must(service.from('customer_profiles').upsert({
    user_id: outsiderCreated.user.id, cpf: generateValidCpf(), full_name: 'Estranho Teste', birth_date: '1991-01-01', phone: '11999990002', city: 'Itapiranga', gender: 'male',
  }, { onConflict: 'user_id' }), 'outsider profile');

  await resolveOrCreateAdminRole(service, 'owner', 'Owner');

  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Payer Details', year: 2026, slug: `payer-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-payer-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 100, female_price: 100 }), 'price');

  const buyer = await clientFor(buyerEmail, password);
  const outsider = await clientFor(outsiderEmail, password);

  const orderResult = await must(buyer.rpc('create_multi_ticket_order_checkout', {
    p_event_id: event.id, p_ticket_category_id: category.id, p_gender: 'male', p_quantity: 1,
    p_payment_method: 'pix', p_buyer_full_name: 'Comprador Teste', p_buyer_cpf: buyerCpf,
    p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
    p_buyer_email: buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
    p_items: [{ ownership_mode: 'self' }], p_client_request_id: `payer-${Date.now()}-${Math.random()}`,
  }), 'create order');
  const orderRow = Array.isArray(orderResult) ? orderResult[0] : orderResult;

  return { service, buyer, outsider, org, event, orderId: orderRow.order_id, buyerCpf, buyerEmail };
}

const fx = await buildFixture();

test('dono do pedido consegue ler os dados do pagador (organization_id/payment_id/nome/email/cpf/telefone)', async () => {
  const result = await fx.buyer.rpc('get_order_payer_details', { p_order_id: fx.orderId });
  assert.equal(result.error, null, result.error?.message);
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  assert.equal(row.organization_id, fx.org.id);
  assert.ok(row.payment_id);
  assert.equal(row.payer_full_name, 'Comprador Teste');
  assert.equal(row.payer_email, fx.buyerEmail);
  assert.equal(row.payer_cpf, fx.buyerCpf);
  assert.equal(row.payer_phone, '11999990001');
});

test('usuario sem acesso ao pedido nao consegue ler os dados do pagador de outra pessoa', async () => {
  const result = await fx.outsider.rpc('get_order_payer_details', { p_order_id: fx.orderId });
  assert.ok(result.error, 'deveria ser rejeitado -- PII de pagamento de outro comprador');
});

test('anon nao consegue chamar a RPC', async () => {
  const anon = createClient((await environment()).url, (await environment()).anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const result = await anon.rpc('get_order_payer_details', { p_order_id: fx.orderId });
  assert.ok(result.error, 'anon nunca deveria conseguir ler dados de pagador');
});
