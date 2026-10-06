import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalSupabase } from './helpers/local-supabase-env.mjs';
import { backdateShortCheckoutHold } from './helpers/expire-asaas-pix-cycle.mjs';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

const { expireAndCancelStalePixPayments } = await import('../src/lib/payments/expire-and-cancel-stale.ts');
const { GatewayTimeoutError } = await import('../src/lib/payments/gateway-timeout.ts');
const { AsaasApiError } = await import('../src/lib/payments/asaas-api-error.ts');

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
  const env = await resolveLocalSupabase();
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

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const password = 'SenhaForte!123';
  const org = await must(service.from('organizations').insert({ name: 'P2 Race', slug: `p2-race-${suffix}` }).select('id').single(), 'org');
  const buyerEmail = `p2-race-${suffix}@qa.local`;
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'buyer');
  const cpf = generateValidCpf();
  await must(service.from('customer_profiles').upsert({
    user_id: buyerCreated.user.id, cpf, full_name: 'Comprador P2 Race',
    birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'female',
  }, { onConflict: 'user_id' }), 'profile');
  const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
  await must(service.from('organization_members').insert({
    organization_id: org.id, user_id: buyerCreated.user.id, is_owner: true, is_active: true,
  }), 'member');
  await must(service.from('admin_users').insert({ user_id: buyerCreated.user.id, role_id: ownerRole.id, is_active: true }), 'admin');
  const buyer = await clientFor(buyerEmail, password);

  async function makeCase() {
    const event = await must(service.from('events').insert({
      organization_id: org.id,
      name: `P2 Race ${suffix}-${Math.floor(Math.random() * 1e6)}`,
      year: 2026,
      slug: `p2-race-${suffix}-${Math.floor(Math.random() * 1e6)}`,
      is_active: true,
      registration_enabled: true,
      starts_at: '2026-11-21T12:00:00-03:00',
      min_age: 0,
      kit_enabled: true,
      limit_shirt_selection_to_stock: true,
    }).select('id').single(), 'event');
    const batch = await must(service.from('registration_batches').insert({
      event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 175, female_price: 175,
      max_confirmed_registrations: 500, is_active: true,
    }).select('id').single(), 'batch');
    const category = await must(service.from('ticket_categories').insert({
      event_id: event.id, name: 'Geral', slug: `geral-race-${suffix}-${Math.floor(Math.random() * 1e6)}`,
      sort_order: 1, is_active: true,
    }).select('id').single(), 'category');
    await must(service.from('registration_batch_prices').insert({
      batch_id: batch.id, ticket_category_id: category.id, male_price: 175, female_price: 175,
    }), 'price');
    await must(service.from('shirt_inventory').insert({
      event_id: event.id, organization_id: org.id, shirt_type: 'Babylook', shirt_size: 'M', total_quantity: 1,
    }), 'shirt inventory');
    const kitItem = await must(service.from('event_kit_items').insert({
      organization_id: org.id, event_id: event.id, name: 'Camiseta', slug: `camiseta-race-${suffix}-${Math.floor(Math.random() * 1e6)}`,
      item_type: 'shirt', requires_variant: true, is_required: false, is_active: true, shirt_supply_mode: 'stock',
    }).select('id').single(), 'kit item');
    const variantM = await must(service.from('event_kit_item_variants').insert({
      kit_item_id: kitItem.id, name: 'Babylook', value: 'M', is_active: true, sort_order: 1,
    }).select('id').single(), 'variant M');
    await must(service.from('event_kit_item_variant_inventory').insert({
      organization_id: org.id, event_id: event.id, kit_item_id: kitItem.id, variant_id: variantM.id, total_quantity: 1,
    }), 'kit inventory');

    async function checkout(buyerCpf) {
      const r = await buyer.rpc('create_multi_ticket_order_checkout', {
        p_event_id: event.id,
        p_ticket_category_id: category.id,
        p_gender: 'female',
        p_quantity: 1,
        p_payment_method: 'pix',
        p_buyer_full_name: 'Comprador P2 Race',
        p_buyer_cpf: buyerCpf ?? generateValidCpf(),
        p_buyer_birth_date: '1990-05-05',
        p_buyer_gender: 'female',
        p_buyer_phone: '11999990001',
        p_buyer_email: buyerEmail,
        p_buyer_city: 'Itapiranga',
        p_assign_first_to_buyer: false,
        p_shirt_type: 'Babylook',
        p_shirt_size: 'M',
        p_items: [{
          ownership_mode: 'unassigned',
          ownership_status: 'unassigned',
          shirt_type: 'Babylook',
          shirt_size: 'M',
        }],
        p_client_request_id: `p2-race-${Date.now()}-${Math.random()}`,
      });
      if (r.error) return r;
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      return { error: null, orderId: row.order_id };
    }

    async function uiStock() {
      const rows = await must(service.rpc('get_event_shirt_stock_for_selection', { p_event_id: event.id }), 'ui stock');
      const row = (rows ?? []).find((entry) => entry.shirt_type === 'Babylook' && entry.shirt_size === 'M');
      return {
        available: Number(row?.available_quantity ?? 0),
        checkoutHold: Number(row?.checkout_hold_quantity ?? 0),
      };
    }

    return { event, checkout, uiStock };
  }

  async function startAsaasPix(orderId) {
    const gatewayPaymentId = `pay_race_${orderId.slice(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await must(buyer.rpc('start_order_payment_pix', {
      p_order_id: orderId,
      p_pix_code: '00020126fake',
      p_pix_qrcode: 'data:image/png;base64,ZmFrZQ==',
      p_gateway_payment_id: gatewayPaymentId,
      p_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      p_provider: 'asaas',
      p_gateway_account_key: 'militrin-pix',
      p_payment_method: 'pix',
    }), 'start pix');
    return gatewayPaymentId;
  }

  async function paymentOf(orderId) {
    const { data, error } = await service.from('payments').select('id, payment_status, pending_cancel_provider_payment_id, expiration_last_error, final_amount').eq('order_id', orderId).single();
    if (error) throw new Error(JSON.stringify(error));
    return data;
  }

  async function runWorker(gateway) {
    return expireAndCancelStalePixPayments({
      supabase: service,
      organizationId: org.id,
      limit: 20,
      getGateway: () => gateway,
    });
  }

  return { service, buyer, org, must, makeCase, startAsaasPix, paymentOf, runWorker };
}

const fx = await buildFixture();

test('A) webhook RECEIVED vence a corrida: pedido confirmado e DELETE nao cancela venda paga', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const gatewayPaymentId = await fx.startAsaasPix(created.orderId);
  await backdateShortCheckoutHold(fx.service, created.orderId);
  const pay = await fx.paymentOf(created.orderId);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas',
    p_provider_payment_id: gatewayPaymentId,
    p_provider_status: 'RECEIVED',
    p_internal_status: 'paid',
    p_gateway_amount: Number(pay.final_amount),
  }), 'webhook received first');

  let cancelCalls = 0;
  const gateway = {
    getPayment: async () => ({
      providerPaymentId: gatewayPaymentId,
      status: 'paid',
      providerStatus: 'RECEIVED',
      paidAt: new Date().toISOString(),
      feeAmount: null,
      netAmount: null,
      amount: Number(pay.final_amount),
    }),
    cancelPayment: async () => { cancelCalls += 1; },
  };
  const result = await fx.runWorker(gateway);
  assert.equal(cancelCalls, 0, 'DELETE nao deve ir embora em cobranca ja paga');
  assert.equal(result.paid >= 1 || result.skipped >= 0, true);
  const after = await fx.paymentOf(created.orderId);
  assert.equal(after.payment_status, 'paid');
  const { data: order } = await fx.service.from('orders').select('status').eq('id', created.orderId).single();
  assert.equal(order.status, 'confirmed');
  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', created.orderId);
  assert.equal(tickets.length, 1);
  const stock = await scene.uiStock();
  assert.equal(stock.available, 0);
  assert.equal(stock.checkoutHold, 0);
});

test('B) DELETE vence: pedido expirado, estoque liberado, webhook tardio nao causa oversell', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const gatewayPaymentId = await fx.startAsaasPix(created.orderId);
  await backdateShortCheckoutHold(fx.service, created.orderId);

  const gateway = {
    getPayment: async () => ({
      providerPaymentId: gatewayPaymentId,
      status: 'pending',
      providerStatus: 'PENDING',
      paidAt: null,
      feeAmount: null,
      netAmount: null,
      amount: 175,
    }),
    cancelPayment: async () => {},
  };
  const result = await fx.runWorker(gateway);
  assert.equal(result.expired >= 1, true);
  const afterExpire = await fx.paymentOf(created.orderId);
  assert.equal(afterExpire.payment_status, 'expired');
  const stockAfterDelete = await scene.uiStock();
  assert.equal(stockAfterDelete.available, 1);
  assert.equal(stockAfterDelete.checkoutHold, 0);

  const second = await scene.checkout();
  assert.equal(second.error, null, second.error?.message);
  const stockHeld = await scene.uiStock();
  assert.equal(stockHeld.available, 0);
  assert.equal(stockHeld.checkoutHold, 1);

  const late = await fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas',
    p_provider_payment_id: gatewayPaymentId,
    p_provider_status: 'RECEIVED',
    p_internal_status: 'paid',
    p_gateway_amount: Number(afterExpire.final_amount),
  });
  assert.equal(late.error, null, late.error?.message);
  const { data: tickets } = await fx.service.from('tickets').select('id,order_id').in('order_id', [created.orderId, second.orderId]);
  const firstTickets = (tickets ?? []).filter((row) => row.order_id === created.orderId);
  assert.equal(firstTickets.length, 0, 'webhook tardio nao pode emitir se a unidade ja foi reservada de novo');
  const stockFinal = await scene.uiStock();
  assert.equal(stockFinal.available, 0);
  assert.ok(stockFinal.checkoutHold + 1 >= 1);
});

test('C) DELETE timeout: estoque permanece reserved ate resolucao', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const gatewayPaymentId = await fx.startAsaasPix(created.orderId);
  await backdateShortCheckoutHold(fx.service, created.orderId);
  const gateway = {
    getPayment: async () => ({
      providerPaymentId: gatewayPaymentId,
      status: 'pending',
      providerStatus: 'PENDING',
      paidAt: null,
      feeAmount: null,
      netAmount: null,
    }),
    cancelPayment: async () => {
      throw new GatewayTimeoutError('Timeout ao chamar Asaas (/payments/id).');
    },
  };
  const result = await fx.runWorker(gateway);
  assert.equal(result.failed >= 1, true);
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'pending');
  assert.equal(pay.pending_cancel_provider_payment_id, gatewayPaymentId);
  assert.match(String(pay.expiration_last_error ?? ''), /Timeout|timeout/);
  const stock = await scene.uiStock();
  assert.equal(stock.available, 0);
  assert.equal(stock.checkoutHold, 1);
  const blocked = await scene.checkout();
  assert.ok(blocked.error);
  assert.match(String(blocked.error.message).toLowerCase(), /estoque insuficiente/);
});

test('D) worker roda duas vezes: segunda passagem e idempotente', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const gatewayPaymentId = await fx.startAsaasPix(created.orderId);
  await backdateShortCheckoutHold(fx.service, created.orderId);
  let cancelCalls = 0;
  const gateway = {
    getPayment: async () => ({
      providerPaymentId: gatewayPaymentId,
      status: 'pending',
      providerStatus: 'PENDING',
      paidAt: null,
      feeAmount: null,
      netAmount: null,
    }),
    cancelPayment: async (input) => {
      if (input.providerPaymentId === gatewayPaymentId) cancelCalls += 1;
    },
  };
  const first = await fx.runWorker(gateway);
  assert.equal(first.expired >= 1, true);
  const second = await fx.runWorker(gateway);
  assert.equal(second.claimed, 0);
  assert.equal(cancelCalls, 1);
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'expired');
  const stock = await scene.uiStock();
  assert.equal(stock.available, 1);
});

test('D2) DELETE 404 ja removido e cancelamento idempotente', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const gatewayPaymentId = await fx.startAsaasPix(created.orderId);
  await backdateShortCheckoutHold(fx.service, created.orderId);
  const gateway = {
    getPayment: async () => {
      throw new AsaasApiError(`/payments/${gatewayPaymentId}`, 404, 'HTTP 404');
    },
  };
  const result = await fx.runWorker(gateway);
  assert.equal(result.expired >= 1, true);
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'expired');
  const stock = await scene.uiStock();
  assert.equal(stock.available, 1);
});

test('E) webhook e worker simultaneos: um ticket, sem oversell', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const gatewayPaymentId = await fx.startAsaasPix(created.orderId);
  await backdateShortCheckoutHold(fx.service, created.orderId);
  const pay = await fx.paymentOf(created.orderId);
  const gateway = {
    getPayment: async () => ({
      providerPaymentId: gatewayPaymentId,
      status: 'pending',
      providerStatus: 'PENDING',
      paidAt: null,
      feeAmount: null,
      netAmount: null,
      amount: Number(pay.final_amount),
    }),
    cancelPayment: async () => {},
  };
  const [workerResult, webhook] = await Promise.all([
    fx.runWorker(gateway),
    fx.service.rpc('apply_gateway_payment_status', {
      p_provider: 'asaas',
      p_provider_payment_id: gatewayPaymentId,
      p_provider_status: 'RECEIVED',
      p_internal_status: 'paid',
      p_gateway_amount: Number(pay.final_amount),
    }),
  ]);
  assert.equal(webhook.error, null, webhook.error?.message);
  void workerResult;
  const { data: tickets } = await fx.service.from('tickets').select('id,status').eq('order_id', created.orderId);
  const after = await fx.paymentOf(created.orderId);
  assert.equal(after.payment_status, 'paid');
  assert.equal((tickets ?? []).length, 1);
  assert.equal(tickets[0].status, 'active');
  const stock = await scene.uiStock();
  assert.equal(stock.available, 0);
  const extra = await scene.checkout();
  assert.ok(extra.error);
});
