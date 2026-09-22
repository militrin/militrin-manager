import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';
import { resolveLocalSupabase } from './helpers/local-supabase-env.mjs';

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

async function ticketSnapshot(service, orderId) {
  const { data, error } = await service.from('tickets')
    .select('id,token,status,used_at,owner_user_id,intended_owner_contact_id,participant_id,order_id,order_item_id')
    .eq('order_id', orderId)
    .order('id');
  if (error) throw new Error(`ticket snapshot: ${JSON.stringify(error)}`);
  const kits = await service.from('participant_kit_items').select('id,ticket_id,status').in('ticket_id', (data ?? []).map((row) => row.id));
  return { tickets: data ?? [], kits: kits.data ?? [] };
}

async function buildFixture() {
  const env = await resolveLocalSupabase();
  const service = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const password = 'SenhaForte!123';
  const org = await must(service.from('organizations').insert({ name: 'Off Gateway Org', slug: `off-gw-${suffix}` }).select('id').single(), 'org');
  const adminEmail = `off-gw-admin-${suffix}@qa.local`;
  const buyerEmail = `off-gw-buyer-${suffix}@qa.local`;
  const adminCreated = await must(service.auth.admin.createUser({ email: adminEmail, password, email_confirm: true }), 'admin');
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'buyer');
  await must(service.from('organization_members').insert({ organization_id: org.id, user_id: adminCreated.user.id, is_owner: true, is_active: true }), 'member');
  const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
  await must(service.from('admin_users').insert({ user_id: adminCreated.user.id, role_id: ownerRole.id, is_active: true }), 'admin_users');
  await must(service.from('customer_profiles').upsert({ user_id: adminCreated.user.id, cpf: '52998224725', full_name: 'Admin Off Gateway', birth_date: '1985-01-01', phone: '11999990000', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'admin profile');
  await must(service.from('customer_profiles').upsert({ user_id: buyerCreated.user.id, cpf: '11144477735', full_name: 'Buyer Off Gateway', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');
  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Off Gateway', year: 2026, slug: `off-gw-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 200, female_price: 200, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 200, female_price: 200 }), 'price');
  const admin = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const buyer = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  await admin.auth.signInWithPassword({ email: adminEmail, password });
  await buyer.auth.signInWithPassword({ email: buyerEmail, password });

  async function issueCourtesy(name) {
    const contact = await must(service.from('registration_contacts').insert({
      organization_id: org.id, full_name: name, email: `${name.replace(/\s+/g, '-').toLowerCase()}-${suffix}@qa.local`, created_by: adminCreated.user.id,
    }).select('id').single(), 'contact');
    const issued = await admin.rpc('issue_manual_ticket_batch', {
      p_registration_contact_id: contact.id,
      p_event_id: event.id,
      p_ticket_category_id: category.id,
      p_batch_id: batch.id,
      p_quantity: 1,
      p_pricing_gender: 'male',
      p_shirt_type: null,
      p_shirt_size: null,
      p_payment_method: 'courtesy',
      p_notes: null,
      p_assign_holder: true,
      p_idempotency_key: `off-gw-${name}-${suffix}`,
    });
    if (issued.error) throw new Error(`issue courtesy: ${JSON.stringify(issued.error)}`);
    const ticketId = issued.data[0].ticket_id;
    const { data: ticket } = await service.from('tickets').select('id,token,status,order_id').eq('id', ticketId).single();
    const { data: payment } = await service.from('payments').select('*').eq('order_id', ticket.order_id).single();
    return { contact, ticket, payment };
  }

  return { service, admin, buyer, org, event, category, batch, must, issueCourtesy, suffix, adminUserId: adminCreated.user.id, buyerEmail };
}

const fx = await buildFixture();
const receivedAt = '2026-09-18T14:30:00.000Z';
const reason = 'PIX recebido diretamente em outra conta, fora do gateway. Regularizacao administrativa.';

test('A: courtesy -> off_gateway PIX 215, financeiro correto, ticket intocado', async () => {
  const { ticket, payment } = await fx.issueCourtesy('Bruno Off Gateway');
  const before = await ticketSnapshot(fx.service, ticket.order_id);
  assert.equal(payment.payment_method, 'courtesy');
  assert.equal(payment.settlement_nature, 'courtesy');
  const result = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id,
    p_method: 'pix',
    p_amount_received: 215,
    p_received_at: receivedAt,
    p_reason: reason,
    p_reference: null,
    p_replace: false,
  });
  assert.equal(result.error, null, result.error?.message);
  assert.equal(result.data.success, true);
  assert.equal(result.data.settlement_nature, 'off_gateway');
  assert.equal(Number(result.data.off_gateway_amount), 215);
  const { data: afterPayment } = await fx.service.from('payments').select('*').eq('id', payment.id).single();
  assert.equal(afterPayment.payment_method, 'courtesy');
  assert.equal(afterPayment.settlement_nature, 'off_gateway');
  assert.equal(afterPayment.off_gateway_method, 'pix');
  assert.equal(Number(afterPayment.off_gateway_amount), 215);
  assert.equal(afterPayment.gateway_payment_id, null);
  assert.equal(Number(afterPayment.final_amount), 0);
  const after = await ticketSnapshot(fx.service, ticket.order_id);
  assert.deepEqual(after, before);
  const { data: audits } = await fx.service.from('audit_logs').select('action,details').eq('entity_id', payment.id).eq('action', 'off_gateway_payment_regularized');
  assert.equal((audits ?? []).length, 1);
  assert.equal(audits[0].details.previous.payment_method, 'courtesy');
  assert.equal(audits[0].details.new.settlement_nature, 'off_gateway');
  assert.equal(audits[0].details.ticket_mutated, false);
});

test('B: amount_received = 0 e bloqueado', async () => {
  const { payment } = await fx.issueCourtesy('Zero Amount');
  const result = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id, p_method: 'pix', p_amount_received: 0, p_received_at: receivedAt, p_reason: reason, p_replace: false,
  });
  assert.ok(result.error);
  assert.match(result.error.message, /AMOUNT_RECEIVED_INVALID/);
});

test('C: amount negativo e bloqueado', async () => {
  const { payment } = await fx.issueCourtesy('Neg Amount');
  const result = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id, p_method: 'pix', p_amount_received: -10, p_received_at: receivedAt, p_reason: reason, p_replace: false,
  });
  assert.ok(result.error);
  assert.match(result.error.message, /AMOUNT_RECEIVED_INVALID/);
});

test('D: sem received_at e bloqueado', async () => {
  const { payment } = await fx.issueCourtesy('No Received At');
  const result = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id, p_method: 'pix', p_amount_received: 215, p_received_at: null, p_reason: reason, p_replace: false,
  });
  assert.ok(result.error);
  assert.match(result.error.message, /RECEIVED_AT_REQUIRED/);
});

test('E: sem reason e bloqueado', async () => {
  const { payment } = await fx.issueCourtesy('No Reason');
  const result = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id, p_method: 'pix', p_amount_received: 215, p_received_at: receivedAt, p_reason: '   ', p_replace: false,
  });
  assert.ok(result.error);
  assert.match(result.error.message, /REASON_REQUIRED/);
});

test('F: payment com gateway LIVE real nao converte', async () => {
  const created = await fx.buyer.rpc('create_multi_ticket_order_checkout', {
    p_event_id: fx.event.id, p_ticket_category_id: fx.category.id, p_gender: 'male', p_quantity: 1,
    p_payment_method: 'pix', p_buyer_full_name: 'Buyer Test', p_buyer_cpf: generateValidCpf(),
    p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
    p_buyer_email: fx.buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
    p_items: [{ ownership_mode: 'self', pricing_gender: 'male' }],
    p_client_request_id: `off-gw-live-${fx.suffix}`,
  });
  if (created.error) throw new Error(`create order: ${JSON.stringify(created.error)}`);
  const order = Array.isArray(created.data) ? created.data[0] : created.data;
  const gatewayPaymentId = `pay_live_${order.order_id.slice(0, 8)}`;
  const started = await fx.buyer.rpc('start_order_payment_pix', {
    p_order_id: order.order_id, p_pix_code: 'FAKE-PIX-CODE', p_pix_qrcode: 'data:image/svg+xml;utf8,fake',
    p_gateway_payment_id: gatewayPaymentId, p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    p_provider: 'asaas',
  });
  if (started.error) throw new Error(`start pix: ${JSON.stringify(started.error)}`);
  await fx.must(fx.service.from('payments').update({
    gateway_account_key: 'asaas-conta-live-01',
    gateway_environment: 'production',
  }).eq('order_id', order.order_id), 'mark live');
  const { data: pendingPayment } = await fx.service.from('payments').select('id,order_id,final_amount').eq('order_id', order.order_id).single();
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED',
    p_internal_status: 'paid', p_gateway_amount: Number(pendingPayment.final_amount),
  }), 'apply paid');
  const payment = pendingPayment;
  const before = await ticketSnapshot(fx.service, payment.order_id);
  const result = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id, p_method: 'pix', p_amount_received: 215, p_received_at: receivedAt, p_reason: reason, p_replace: false,
  });
  assert.ok(result.error);
  assert.match(result.error.message, /GATEWAY_LIVE_PAYMENT/);
  const after = await ticketSnapshot(fx.service, payment.order_id);
  assert.deepEqual(after, before);
});

test('G: repetir a mesma regularizacao e idempotente sem auditoria duplicada', async () => {
  const { payment, ticket } = await fx.issueCourtesy('Idempotent Case');
  const first = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id, p_method: 'pix', p_amount_received: 215, p_received_at: receivedAt, p_reason: reason, p_replace: false,
  });
  assert.equal(first.error, null, first.error?.message);
  const beforeTickets = await ticketSnapshot(fx.service, ticket.order_id);
  const second = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id, p_method: 'pix', p_amount_received: 215, p_received_at: receivedAt, p_reason: reason, p_replace: false,
  });
  assert.equal(second.error, null, second.error?.message);
  assert.equal(second.data.idempotent, true);
  const { data: audits } = await fx.service.from('audit_logs').select('id').eq('entity_id', payment.id).eq('action', 'off_gateway_payment_regularized');
  assert.equal((audits ?? []).length, 1);
  const afterTickets = await ticketSnapshot(fx.service, ticket.order_id);
  assert.deepEqual(afterTickets, beforeTickets);
});

test('H: alterar regularizacao existente exige replace explicito', async () => {
  const { payment, ticket } = await fx.issueCourtesy('Replace Case');
  const first = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id, p_method: 'pix', p_amount_received: 215, p_received_at: receivedAt, p_reason: reason, p_replace: false,
  });
  assert.equal(first.error, null, first.error?.message);
  const silent = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id, p_method: 'pix', p_amount_received: 220, p_received_at: receivedAt, p_reason: reason, p_replace: false,
  });
  assert.ok(silent.error);
  assert.match(silent.error.message, /OFF_GATEWAY_ALREADY_RECORDED/);
  const before = await ticketSnapshot(fx.service, ticket.order_id);
  const replaced = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id, p_method: 'pix', p_amount_received: 220, p_received_at: receivedAt, p_reason: `${reason} substituicao`, p_replace: true,
  });
  assert.equal(replaced.error, null, replaced.error?.message);
  assert.equal(replaced.data.replaced, true);
  const { data: afterPayment } = await fx.service.from('payments').select('off_gateway_amount,payment_method').eq('id', payment.id).single();
  assert.equal(Number(afterPayment.off_gateway_amount), 220);
  assert.equal(afterPayment.payment_method, 'courtesy');
  const { data: audits } = await fx.service.from('audit_logs').select('id').eq('entity_id', payment.id).eq('action', 'off_gateway_payment_regularized');
  assert.equal((audits ?? []).length, 2);
  const after = await ticketSnapshot(fx.service, ticket.order_id);
  assert.deepEqual(after, before);
});

test('I: cupom 100% continua coupon_zero e nao converte', async () => {
  const order = await fx.must(fx.service.from('orders').insert({
    organization_id: fx.org.id, event_id: fx.event.id, order_number: `CUP-${fx.suffix}`, status: 'confirmed',
    base_amount: 200, discount_amount: 200, final_amount: 0, buyer_type: 'administrative',
  }).select('id').single(), 'coupon order');
  const payment = await fx.must(fx.service.from('payments').insert({
    organization_id: fx.org.id, event_id: fx.event.id, order_id: order.id,
    amount: 200, discount_amount: 200, final_amount: 0, payment_method: 'pix', payment_status: 'paid', paid_at: new Date().toISOString(),
  }).select('id,settlement_nature,payment_method,final_amount').single(), 'coupon payment');
  assert.equal(payment.settlement_nature, 'coupon_zero');
  assert.equal(payment.payment_method, 'pix');
  const result = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id, p_method: 'pix', p_amount_received: 215, p_received_at: receivedAt, p_reason: reason, p_replace: false,
  });
  assert.ok(result.error);
  assert.match(result.error.message, /COUPON_ZERO_NOT_OFF_GATEWAY/);
  const { data: after } = await fx.service.from('payments').select('settlement_nature,payment_method,final_amount,off_gateway_recorded_at').eq('id', payment.id).single();
  assert.equal(after.settlement_nature, 'coupon_zero');
  assert.equal(after.payment_method, 'pix');
  assert.equal(Number(after.final_amount), 0);
  assert.equal(after.off_gateway_recorded_at, null);
});

test('J: cortesia normal continua courtesy sem regularizacao', async () => {
  const { payment } = await fx.issueCourtesy('Plain Courtesy');
  assert.equal(payment.settlement_nature, 'courtesy');
  assert.equal(payment.payment_method, 'courtesy');
  assert.equal(Number(payment.final_amount), 0);
  assert.equal(payment.off_gateway_recorded_at, null);
});

test('N: nenhuma regularizacao emite, cancela ou muda ticket', async () => {
  const { ticket, payment } = await fx.issueCourtesy('Ticket Freeze');
  await fx.must(fx.service.from('tickets').update({ status: 'used', used_at: new Date().toISOString() }).eq('id', ticket.id), 'mark used');
  const before = await ticketSnapshot(fx.service, ticket.order_id);
  const result = await fx.admin.rpc('regularize_off_gateway_payment', {
    p_payment_id: payment.id, p_method: 'pix', p_amount_received: 215, p_received_at: receivedAt, p_reason: reason, p_replace: false,
  });
  assert.equal(result.error, null, result.error?.message);
  const after = await ticketSnapshot(fx.service, ticket.order_id);
  assert.deepEqual(after, before);
  assert.equal(after.tickets[0].status, 'used');
  assert.equal(after.tickets[0].token, before.tickets[0].token);
});
