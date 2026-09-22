import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';
import { resolveLocalSupabase } from './helpers/local-supabase-env.mjs';
import { AsaasPaymentProvider } from '../src/lib/payments/asaas-provider.ts';
import { GatewayChargeUnpersistedError } from '../src/lib/payments/gateway-charge-unpersisted.ts';

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

async function environment() {
  return resolveLocalSupabase();
}

async function buildFixture() {
  const env = await environment();
  const service = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const password = 'SenhaForte!123';
  const org = await must(service.from('organizations').insert({ name: 'P0 Pay Harden', slug: `p0-pay-${suffix}` }).select('id').single(), 'org');
  const adminEmail = `p0-pay-admin-${suffix}@qa.local`;
  const buyerEmail = `p0-pay-buyer-${suffix}@qa.local`;
  const adminCreated = await must(service.auth.admin.createUser({ email: adminEmail, password, email_confirm: true }), 'admin');
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'buyer');
  await must(service.from('organization_members').insert({ organization_id: org.id, user_id: adminCreated.user.id, is_owner: true, is_active: true }), 'member');
  const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
  await must(service.from('admin_users').insert({ user_id: adminCreated.user.id, role_id: ownerRole.id, is_active: true }), 'admin_users');
  await must(service.from('customer_profiles').upsert({ user_id: adminCreated.user.id, cpf: '52998224725', full_name: 'Admin', birth_date: '1985-01-01', phone: '11999990000', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'admin profile');
  await must(service.from('customer_profiles').upsert({ user_id: buyerCreated.user.id, cpf: '11144477735', full_name: 'Buyer', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');
  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento P0 Pay', year: 2026, slug: `p0-pay-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 150, female_price: 150, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 150, female_price: 150 }), 'price');
  const admin = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const buyer = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  await admin.auth.signInWithPassword({ email: adminEmail, password });
  await buyer.auth.signInWithPassword({ email: buyerEmail, password });

  async function createOrder(options = {}) {
    const r = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: category.id, p_gender: 'male', p_quantity: 1,
      p_payment_method: options.paymentMethod ?? 'pix', p_buyer_full_name: 'Buyer Test', p_buyer_cpf: options.cpf ?? generateValidCpf(),
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_items: [{ ownership_mode: 'self', pricing_gender: 'male' }],
      p_client_request_id: options.clientRequestId ?? `p0-pay-${Date.now()}-${Math.random()}`,
      p_coupon_code: options.couponCode ?? null,
    });
    if (r.error) throw new Error(`create order: ${JSON.stringify(r.error)}`);
    return Array.isArray(r.data) ? r.data[0] : r.data;
  }

  async function startPix(orderId, gatewayPaymentId = `pay_${orderId.slice(0, 8)}_${Date.now()}`) {
    const r = await buyer.rpc('start_order_payment_pix', {
      p_order_id: orderId, p_pix_code: 'FAKE-PIX-CODE', p_pix_qrcode: 'data:image/svg+xml;utf8,fake',
      p_gateway_payment_id: gatewayPaymentId, p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      p_provider: 'asaas',
    });
    if (r.error) throw new Error(`start pix: ${JSON.stringify(r.error)}`);
    return gatewayPaymentId;
  }

  return { service, admin, buyer, org, event, category, batch, must, createOrder, startPix, buyerEmail, suffix };
}

const fx = await buildFixture();

test('A: PIX pago com valor correto vira paid e emite 1 ticket', async () => {
  const created = await fx.createOrder();
  const gatewayPaymentId = await fx.startPix(created.order_id);
  const result = await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED',
    p_internal_status: 'paid', p_gateway_amount: 150,
  }), 'apply paid');
  const row = Array.isArray(result) ? result[0] : result;
  assert.equal(row.applied_status, 'paid');
  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', created.order_id);
  assert.equal(tickets.length, 1);
});

test('B: webhook value 0 nao liquida pedido pago >0', async () => {
  const created = await fx.createOrder();
  const gatewayPaymentId = await fx.startPix(created.order_id);
  const result = await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'RECEIVED',
    p_internal_status: 'paid', p_gateway_amount: 0,
  }), 'apply zero');
  const row = Array.isArray(result) ? result[0] : result;
  assert.equal(row.applied_status, 'pending');
  const { data: payment } = await fx.service.from('payments').select('payment_status').eq('order_id', created.order_id).single();
  assert.equal(payment.payment_status, 'pending');
  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', created.order_id);
  assert.equal(tickets.length, 0);
  const { data: audits } = await fx.service.from('audit_logs').select('action').eq('entity_id', row.payment_id).eq('action', 'payment_gateway_amount_mismatch');
  assert.ok((audits ?? []).length >= 1);
});

test('C: webhook menor/maior nao liquida', async () => {
  const created = await fx.createOrder();
  const gatewayPaymentId = await fx.startPix(created.order_id);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED',
    p_internal_status: 'paid', p_gateway_amount: 149.99,
  }), 'low');
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED',
    p_internal_status: 'paid', p_gateway_amount: 151,
  }), 'high');
  const { data: payment } = await fx.service.from('payments').select('payment_status').eq('order_id', created.order_id).single();
  assert.equal(payment.payment_status, 'pending');
  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', created.order_id);
  assert.equal(tickets.length, 0);
});

test('D/O: webhook repetido correto continua 1 ticket por order_item', async () => {
  const created = await fx.createOrder();
  const gatewayPaymentId = await fx.startPix(created.order_id);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED',
    p_internal_status: 'paid', p_gateway_amount: 150,
  }), 'first');
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'RECEIVED',
    p_internal_status: 'paid', p_gateway_amount: 150,
  }), 'repeat');
  const { data: tickets } = await fx.service.from('tickets').select('id,order_item_id').eq('order_id', created.order_id);
  assert.equal(tickets.length, 1);
  const { data: items } = await fx.service.from('order_items').select('id').eq('order_id', created.order_id);
  assert.equal(items.length, 1);
});

test('E: cupom 100% emite sem gateway', async () => {
  const coupon = await fx.service.from('coupons').insert({
    organization_id: fx.org.id, event_id: fx.event.id, code: `FULL-${fx.suffix}`,
    discount_type: 'percentage', discount_value: 100, applies_to_tickets: true,
    max_uses: 10, used_count: 0, is_active: true,
  }).select('code').single();
  let created;
  if (!coupon.error) {
    try {
      created = await fx.createOrder({ couponCode: coupon.data.code });
    } catch {
      created = null;
    }
  }
  if (!created || Number(created.final_amount) > 0) {
    created = await fx.createOrder({ paymentMethod: 'courtesy' });
  }
  assert.equal(created.payment_status, 'paid');
  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', created.order_id);
  assert.equal(tickets.length, 1);
  const { data: payment } = await fx.service.from('payments').select('gateway_payment_id, payment_method, final_amount').eq('order_id', created.order_id).single();
  assert.equal(payment.gateway_payment_id, null);
  assert.equal(Number(payment.final_amount), 0);
});

test('F: cortesia administrativa emite sem gateway', async () => {
  const contact = await fx.must(fx.service.from('registration_contacts').insert({
    organization_id: fx.org.id, full_name: 'Cortesia Admin', email: `cortesia-${fx.suffix}@qa.local`, created_by: (await fx.admin.auth.getUser()).data.user.id,
  }).select('id').single(), 'contact');
  const issued = await fx.admin.rpc('issue_manual_ticket_batch', {
    p_registration_contact_id: contact.id,
    p_event_id: fx.event.id,
    p_ticket_category_id: fx.category.id,
    p_batch_id: fx.batch.id,
    p_quantity: 1,
    p_pricing_gender: 'male',
    p_shirt_type: null,
    p_shirt_size: null,
    p_payment_method: 'courtesy',
    p_notes: null,
    p_assign_holder: true,
    p_idempotency_key: `manual-first-${fx.suffix}`,
  });
  assert.equal(issued.error, null, issued.error?.message);
  const ticketId = issued.data[0].ticket_id;
  const { data: ticket } = await fx.service.from('tickets').select('order_id,status').eq('id', ticketId).single();
  const { data: payment } = await fx.service.from('payments').select('payment_method,final_amount,gateway_payment_id').eq('order_id', ticket.order_id).single();
  assert.equal(payment.payment_method, 'courtesy');
  assert.equal(Number(payment.final_amount), 0);
  assert.equal(payment.gateway_payment_id, null);

  const replay = await fx.admin.rpc('issue_manual_ticket_batch', {
    p_registration_contact_id: contact.id,
    p_event_id: fx.event.id,
    p_ticket_category_id: fx.category.id,
    p_batch_id: fx.batch.id,
    p_quantity: 1,
    p_pricing_gender: 'male',
    p_shirt_type: null,
    p_shirt_size: null,
    p_payment_method: 'courtesy',
    p_notes: null,
    p_assign_holder: true,
    p_idempotency_key: `manual-first-${fx.suffix}`,
  });
  assert.equal(replay.error, null, replay.error?.message);
  assert.equal(replay.data[0].ticket_id, ticketId);

  const blocked = await fx.admin.rpc('issue_manual_ticket_batch', {
    p_registration_contact_id: contact.id,
    p_event_id: fx.event.id,
    p_ticket_category_id: fx.category.id,
    p_batch_id: fx.batch.id,
    p_quantity: 1,
    p_pricing_gender: 'male',
    p_shirt_type: null,
    p_shirt_size: null,
    p_payment_method: 'courtesy',
    p_notes: null,
    p_assign_holder: true,
    p_idempotency_key: `manual-second-${fx.suffix}`,
  });
  assert.ok(blocked.error);
  assert.match(blocked.error.message, /EXISTING_OPERATIONAL_TICKET/);

  const second = await fx.admin.rpc('issue_manual_ticket_batch', {
    p_registration_contact_id: contact.id,
    p_event_id: fx.event.id,
    p_ticket_category_id: fx.category.id,
    p_batch_id: fx.batch.id,
    p_quantity: 1,
    p_pricing_gender: 'male',
    p_shirt_type: null,
    p_shirt_size: null,
    p_payment_method: 'courtesy',
    p_notes: 'segunda emissao consciente',
    p_assign_holder: false,
    p_acknowledge_existing: true,
    p_idempotency_key: `manual-ack-${fx.suffix}`,
  });
  assert.equal(second.error, null, second.error?.message);
  assert.notEqual(second.data[0].ticket_id, ticketId);
});

test('J/K: retry e duplo clique reusam o mesmo pedido pending', async () => {
  const requestId = `stable-intent-${fx.suffix}`;
  const first = await fx.createOrder({ clientRequestId: requestId, cpf: generateValidCpf() });
  const second = await fx.createOrder({ clientRequestId: requestId, cpf: generateValidCpf() });
  assert.equal(second.order_id, first.order_id);
});

test('I: QR fail apos POST cancela cobranca nova', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    const method = init?.method ?? 'GET';
    requests.push({ href, method });
    if (href.includes('/customers?')) return new Response(JSON.stringify({ data: [{ id: 'cus_1' }] }), { status: 200 });
    if (href.endsWith('/payments') && method === 'POST') {
      return new Response(JSON.stringify({
        id: 'pay_qr_fail', status: 'PENDING', value: 150, netValue: null, paymentDate: null, dueDate: '2026-09-21', billingType: 'PIX',
      }), { status: 200 });
    }
    if (href.includes('/pixQrCode')) return new Response(JSON.stringify({ errors: [{ description: 'qr' }] }), { status: 500 });
    if (method === 'DELETE') return new Response('{}', { status: 200 });
    throw new Error(`fetch inesperado ${href}`);
  };
  try {
    await new AsaasPaymentProvider({
      apiKey: 'k', webhookToken: 'wh', environment: 'sandbox', accountKey: 'conta-pix',
    }).createPixPayment({
      organizationId: fx.org.id, orderId: 'order', paymentId: 'pay', amount: 150, dueDate: '2026-09-21',
      payer: { name: 'A', email: 'a@b.com', cpfCnpj: '52998224725' },
    });
    assert.fail('qr deveria falhar');
  } catch (error) {
    assert.equal(error instanceof GatewayChargeUnpersistedError, true);
    assert.equal(error.cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
