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
  const orgA = await must(service.from('organizations').insert({ name: `PIX Issue A ${suffix}`, slug: `pix-issue-a-${suffix}` }).select('id').single(), 'orgA');
  const orgB = await must(service.from('organizations').insert({ name: `PIX Issue B ${suffix}`, slug: `pix-issue-b-${suffix}` }).select('id').single(), 'orgB');

  const adminAEmail = `pix-issue-admin-a-${suffix}@qa.local`;
  const adminBEmail = `pix-issue-admin-b-${suffix}@qa.local`;
  const viewerEmail = `pix-issue-viewer-${suffix}@qa.local`;
  const buyerEmail = `pix-issue-buyer-${suffix}@qa.local`;
  const adminAUser = await must(service.auth.admin.createUser({ email: adminAEmail, password, email_confirm: true }), 'adminA');
  const adminBUser = await must(service.auth.admin.createUser({ email: adminBEmail, password, email_confirm: true }), 'adminB');
  const viewerUser = await must(service.auth.admin.createUser({ email: viewerEmail, password, email_confirm: true }), 'viewer');
  const buyerUser = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'buyer');

  await must(service.from('customer_profiles').upsert({ user_id: buyerUser.user.id, cpf: generateValidCpf(), full_name: 'Buyer Issue', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');

  const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
  let viewerRole = await service.from('admin_roles').select('id').eq('code', 'pix_issue_integrity_only').maybeSingle();
  if (!viewerRole.data) {
    viewerRole = await service.from('admin_roles').insert({ code: 'pix_issue_integrity_only', name: 'Integrity Only PIX', is_system: false, is_active: true }).select('id').single();
  }
  const integrityPermission = await must(service.from('admin_permissions').select('id').eq('code', 'integrity.view').single(), 'integrity.view');
  await service.from('admin_role_permissions').upsert({ role_id: viewerRole.data.id, permission_id: integrityPermission.id }, { onConflict: 'role_id,permission_id' });

  await must(service.from('organization_members').insert([
    { organization_id: orgA.id, user_id: adminAUser.user.id, is_owner: true, is_active: true },
    { organization_id: orgB.id, user_id: adminBUser.user.id, is_owner: true, is_active: true },
    { organization_id: orgA.id, user_id: viewerUser.user.id, is_owner: false, is_active: true },
  ]), 'memberships');
  await must(service.from('admin_users').insert([
    { user_id: adminAUser.user.id, role_id: ownerRole.id, is_active: true },
    { user_id: adminBUser.user.id, role_id: ownerRole.id, is_active: true },
    { user_id: viewerUser.user.id, role_id: viewerRole.data.id, is_active: true },
  ]), 'admin users');

  const event = await must(service.from('events').insert({
    organization_id: orgA.id, name: 'Evento PIX Issue', year: 2026, slug: `pix-issue-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-issue-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 100, female_price: 100 }), 'price');
  const product = await must(service.from('store_items').insert({
    organization_id: orgA.id, event_id: event.id, name: 'Copo Issue', slug: `copo-issue-${suffix}`, price: 30, is_active: true, supply_mode: 'made_to_order',
  }).select('id').single(), 'product');

  const adminA = await clientFor(adminAEmail, password);
  const adminB = await clientFor(adminBEmail, password);
  const viewer = await clientFor(viewerEmail, password);
  const buyer = await clientFor(buyerEmail, password);

  async function createOrder(quantity = 1) {
    const items = Array.from({ length: quantity }, () => ({ ownership_mode: 'self' }));
    if (quantity > 1) {
      items[1] = { ownership_mode: 'unassigned' };
    }
    const result = await must(buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: category.id, p_gender: 'male', p_quantity: quantity,
      p_payment_method: 'pix', p_buyer_full_name: 'Buyer Issue', p_buyer_cpf: generateValidCpf(),
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: quantity === 1,
      p_items: items, p_client_request_id: `pix-issue-${Date.now()}-${Math.random()}`,
    }), 'create order');
    const row = Array.isArray(result) ? result[0] : result;
    return row.order_id;
  }

  async function startPix(orderId) {
    const gatewayPaymentId = `pay_${orderId.slice(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await must(buyer.rpc('start_order_payment_pix', {
      p_order_id: orderId,
      p_pix_code: 'FAKE-PIX',
      p_pix_qrcode: 'data:image/svg+xml;utf8,fake',
      p_gateway_payment_id: gatewayPaymentId,
      p_expires_at: new Date(Date.now() - 60_000).toISOString(),
      p_provider: 'asaas',
      p_gateway_account_key: 'militrin-temp',
    }), 'start pix');
    return gatewayPaymentId;
  }

  async function expireAndPay(orderId, gatewayPaymentId) {
    await must(service.rpc('expire_stale_order_payments', { p_organization_id: orgA.id }), 'expire');
    await must(service.rpc('apply_gateway_payment_status', {
      p_provider: 'asaas',
      p_provider_payment_id: gatewayPaymentId,
      p_provider_status: 'RECEIVED',
      p_internal_status: 'paid',
    }), 'late paid');
    return orderId;
  }

  return { service, must, anonymous, adminA, adminB, viewer, buyer, orgA, orgB, event, product, createOrder, startPix, expireAndPay, suffix };
}

const fx = await buildFixture();

test('pagamento tardio registra dinheiro, nao emite, e entra na fila visivel', async () => {
  const orderId = await fx.createOrder(1);
  const gatewayPaymentId = await fx.startPix(orderId);
  await fx.expireAndPay(orderId, gatewayPaymentId);

  const { data: payment } = await fx.service.from('payments').select('payment_status').eq('order_id', orderId).single();
  assert.equal(payment.payment_status, 'paid');
  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', orderId);
  assert.equal(tickets.length, 0);

  const queue = await fx.must(fx.adminA.rpc('list_paid_orders_awaiting_ticket_issue'), 'list queue');
  assert.ok(queue.some((row) => row.order_id === orderId));
  const row = queue.find((row) => row.order_id === orderId);
  assert.equal(row.expected_ticket_items, 1);
  assert.equal(row.missing_ticket_items, 1);
  assert.match(String(row.pending_reason), /expiracao|ingresso/i);
});

test('admin autorizado emite, retry nao duplica, fila some e ha audit', async () => {
  const orderId = await fx.createOrder(1);
  const gatewayPaymentId = await fx.startPix(orderId);
  await fx.expireAndPay(orderId, gatewayPaymentId);

  const issued = await fx.must(fx.adminA.rpc('admin_issue_tickets_for_paid_order', {
    p_order_id: orderId,
    p_reason: 'Pagamento tardio Asaas confirmado',
  }), 'issue');
  assert.equal(issued.success, true);
  assert.equal(issued.active_ticket_count, 1);

  const retry = await fx.must(fx.adminA.rpc('admin_issue_tickets_for_paid_order', {
    p_order_id: orderId,
    p_reason: 'Retry idempotente da mesma emissao',
  }), 'retry issue');
  assert.equal(retry.active_ticket_count, 1);
  const { data: tickets } = await fx.service.from('tickets').select('id,status').eq('order_id', orderId);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].status, 'active');

  const queue = await fx.must(fx.adminA.rpc('list_paid_orders_awaiting_ticket_issue'), 'list after issue');
  assert.equal(queue.some((row) => row.order_id === orderId), false);

  const { data: audit } = await fx.service.from('audit_logs').select('id,details').eq('action', 'admin_issue_tickets_for_paid_order').eq('entity_id', orderId);
  assert.ok(audit.length >= 1);
  assert.match(String(audit[0].details.reason), /tardio|Retry/i);
});

test('N ingressos e produto no mesmo pedido: so ingressos sao emitidos', async () => {
  const orderId = await fx.createOrder(2);
  await fx.must(fx.buyer.rpc('add_product_to_cart_order', { p_order_id: orderId, p_store_item_id: fx.product.id, p_quantity: 1 }), 'add product');
  const gatewayPaymentId = await fx.startPix(orderId);
  await fx.expireAndPay(orderId, gatewayPaymentId);

  const issued = await fx.must(fx.adminA.rpc('admin_issue_tickets_for_paid_order', {
    p_order_id: orderId,
    p_reason: 'Pedido misto apos pagamento tardio',
  }), 'issue mixed');
  assert.equal(issued.active_ticket_count, 2);
  const { data: tickets } = await fx.service.from('tickets').select('id,order_item_id').eq('order_id', orderId);
  assert.equal(tickets.length, 2);
  const { data: products } = await fx.service.from('order_items').select('id,status,item_kind').eq('order_id', orderId).eq('item_kind', 'product');
  assert.equal(products.length, 1);
  assert.equal(products[0].status, 'confirmed');
});

test('RBAC: viewer, anon e outra org nao emitem', async () => {
  const orderId = await fx.createOrder(1);
  const gatewayPaymentId = await fx.startPix(orderId);
  await fx.expireAndPay(orderId, gatewayPaymentId);

  const viewerList = await fx.viewer.rpc('list_paid_orders_awaiting_ticket_issue');
  assert.equal(viewerList.error, null, viewerList.error?.message);
  assert.ok(viewerList.data.some((row) => row.order_id === orderId));

  const viewerIssue = await fx.viewer.rpc('admin_issue_tickets_for_paid_order', {
    p_order_id: orderId,
    p_reason: 'Tentativa sem permissao financeira',
  });
  assert.ok(viewerIssue.error);

  const otherOrg = await fx.adminB.rpc('admin_issue_tickets_for_paid_order', {
    p_order_id: orderId,
    p_reason: 'Tentativa de outra organizacao',
  });
  assert.ok(otherOrg.error);

  const anonIssue = await fx.anonymous.rpc('admin_issue_tickets_for_paid_order', {
    p_order_id: orderId,
    p_reason: 'Tentativa anonima de emissao',
  });
  assert.ok(anonIssue.error);

  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', orderId);
  assert.equal(tickets.length, 0);
});

test('motivo curto e recusado', async () => {
  const orderId = await fx.createOrder(1);
  const gatewayPaymentId = await fx.startPix(orderId);
  await fx.expireAndPay(orderId, gatewayPaymentId);
  const short = await fx.adminA.rpc('admin_issue_tickets_for_paid_order', { p_order_id: orderId, p_reason: 'curto' });
  assert.ok(short.error);
});
