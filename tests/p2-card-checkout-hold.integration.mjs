import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalSupabase } from './helpers/local-supabase-env.mjs';
import { backdateShortCheckoutHold } from './helpers/expire-asaas-pix-cycle.mjs';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';
import { GatewayTimeoutError } from '../src/lib/payments/gateway-timeout.ts';
import { AsaasApiError } from '../src/lib/payments/asaas-api-error.ts';

const { expireAndCancelStaleCheckoutPayments } = await import('../src/lib/payments/expire-and-cancel-stale.ts');

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

function pendingSnapshot(id, amount = 175) {
  return {
    providerPaymentId: id,
    status: 'pending',
    providerStatus: 'PENDING',
    paidAt: null,
    feeAmount: null,
    netAmount: null,
    amount,
  };
}

function paidSnapshot(id, amount = 175) {
  return {
    providerPaymentId: id,
    status: 'paid',
    providerStatus: 'CONFIRMED',
    paidAt: new Date().toISOString(),
    feeAmount: null,
    netAmount: null,
    amount,
  };
}

function goneSnapshot(id, amount = 175) {
  return {
    providerPaymentId: id,
    status: 'cancelled',
    providerStatus: 'DELETED',
    paidAt: null,
    feeAmount: null,
    netAmount: null,
    amount,
  };
}

function trackingGateway({ onCancel, paidIds, amounts } = {}) {
  const cancelled = new Set();
  const paid = paidIds ?? new Set();
  const amountOf = (id) => (amounts && amounts[id] != null ? Number(amounts[id]) : 175);
  return {
    cancelled,
    gateway: {
      getPayment: async (input) => {
        const amount = amountOf(input.providerPaymentId);
        if (paid.has(input.providerPaymentId)) return paidSnapshot(input.providerPaymentId, amount);
        if (cancelled.has(input.providerPaymentId)) return goneSnapshot(input.providerPaymentId, amount);
        return pendingSnapshot(input.providerPaymentId, amount);
      },
      cancelPayment: async (input) => {
        if (onCancel) await onCancel(input, cancelled);
        else cancelled.add(input.providerPaymentId);
      },
    },
  };
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
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const password = 'SenhaForte!123';
  const org = await must(service.from('organizations').insert({ name: 'P2 Card', slug: `p2-card-${suffix}` }).select('id').single(), 'org');
  const buyerEmail = `p2-card-${suffix}@qa.local`;
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'buyer');
  const cpf = generateValidCpf();
  await must(service.from('customer_profiles').upsert({
    user_id: buyerCreated.user.id, cpf, full_name: 'Comprador P2 Card',
    birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'female',
  }, { onConflict: 'user_id' }), 'profile');
  const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
  await must(service.from('organization_members').insert({
    organization_id: org.id, user_id: buyerCreated.user.id, is_owner: true, is_active: true,
  }), 'member');
  await must(service.from('admin_users').insert({ user_id: buyerCreated.user.id, role_id: ownerRole.id, is_active: true }), 'admin');
  const buyer = createClient(env.url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await buyer.auth.signInWithPassword({ email: buyerEmail, password });
  if (signIn.error) throw new Error(`login: ${signIn.error.message}`);

  async function makeCase() {
    const caseSuffix = `${suffix}-${Math.floor(Math.random() * 1e6)}`;
    const caseOrg = await must(service.from('organizations').insert({
      name: `P2 Card ${caseSuffix}`, slug: `p2-card-${caseSuffix}`,
    }).select('id').single(), 'case org');
    await must(service.from('organization_members').insert({
      organization_id: caseOrg.id, user_id: buyerCreated.user.id, is_owner: true, is_active: true,
    }), 'case member');
    const event = await must(service.from('events').insert({
      organization_id: caseOrg.id,
      name: `P2 Card ${suffix}-${Math.floor(Math.random() * 1e6)}`,
      year: 2026,
      slug: `p2-card-${suffix}-${Math.floor(Math.random() * 1e6)}`,
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
      event_id: event.id, name: 'Geral', slug: `geral-card-${suffix}-${Math.floor(Math.random() * 1e6)}`,
      sort_order: 1, is_active: true,
    }).select('id').single(), 'category');
    await must(service.from('registration_batch_prices').insert({
      batch_id: batch.id, ticket_category_id: category.id, male_price: 175, female_price: 175,
    }), 'price');
    await must(service.from('shirt_inventory').insert({
      event_id: event.id, organization_id: caseOrg.id, shirt_type: 'Babylook', shirt_size: 'M', total_quantity: 1,
    }), 'shirt inventory');
    const kitItem = await must(service.from('event_kit_items').insert({
      organization_id: caseOrg.id, event_id: event.id, name: 'Camiseta', slug: `camiseta-card-${suffix}-${Math.floor(Math.random() * 1e6)}`,
      item_type: 'shirt', requires_variant: true, is_required: false, is_active: true, shirt_supply_mode: 'stock',
    }).select('id').single(), 'kit item');
    const variantM = await must(service.from('event_kit_item_variants').insert({
      kit_item_id: kitItem.id, name: 'Babylook', value: 'M', is_active: true, sort_order: 1,
    }).select('id').single(), 'variant M');
    await must(service.from('event_kit_item_variant_inventory').insert({
      organization_id: caseOrg.id, event_id: event.id, kit_item_id: kitItem.id, variant_id: variantM.id, total_quantity: 1,
    }), 'kit inventory');

    async function checkout() {
      const r = await buyer.rpc('create_multi_ticket_order_checkout', {
        p_event_id: event.id,
        p_ticket_category_id: category.id,
        p_gender: 'female',
        p_quantity: 1,
        p_payment_method: 'credit_card',
        p_buyer_full_name: 'Comprador P2 Card',
        p_buyer_cpf: generateValidCpf(),
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
        p_client_request_id: `p2-card-${Date.now()}-${Math.random()}`,
      });
      if (r.error) return r;
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      return { error: null, orderId: row.order_id };
    }

    async function uiStock() {
      const rows = await must(service.rpc('get_event_shirt_stock_for_selection', { p_event_id: event.id }), 'ui stock');
      const row = (rows ?? []).find((entry) => entry.shirt_type === 'Babylook' && entry.shirt_size === 'M');
      const availableWriter = await must(service.rpc('canonical_shirt_available_for_new_reservation', {
        p_event_id: event.id,
        p_shirt_type: 'Babylook',
        p_shirt_size: 'M',
      }), 'writer stock');
      return {
        available: Number(row?.available_quantity ?? 0),
        checkoutHold: Number(row?.checkout_hold_quantity ?? 0),
        writerAvailable: Number(availableWriter ?? 0),
      };
    }

    async function runWorker(gateway) {
      return expireAndCancelStaleCheckoutPayments({
        supabase: service,
        organizationId: caseOrg.id,
        limit: 20,
        getGateway: () => gateway,
      });
    }

    return { event, checkout, uiStock, org: caseOrg, runWorker };
  }

  async function startCard(orderId, { installments = 1 } = {}) {
    const rootId = `pay_card_${orderId.slice(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const installmentId = installments >= 2 ? `inst_${rootId}` : null;
    const charges = Array.from({ length: installments }, (_, index) => ({
      gateway_payment_id: index === 0 ? rootId : `${rootId}_p${index + 1}`,
      gateway_installment_id: installmentId,
      installment_number: index + 1,
      installment_count: installments,
      amount: installments >= 2 ? Math.round((175 / installments) * 100) / 100 : 175,
    }));
    await must(buyer.rpc('start_order_payment_pix', {
      p_order_id: orderId,
      p_pix_code: '',
      p_pix_qrcode: '',
      p_gateway_payment_id: rootId,
      p_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      p_provider: 'asaas',
      p_gateway_account_key: 'militrin-card',
      p_payment_method: 'credit_card',
      p_checkout_url: `https://checkout.invalid/${rootId}`,
      p_gateway_installment_id: installmentId,
      p_gateway_charges: charges,
    }), 'start card');
    return { rootId, installmentId, chargeIds: charges.map((row) => row.gateway_payment_id), charges };
  }

  async function paymentOf(orderId) {
    const { data, error } = await service.from('payments').select('id, payment_status, pending_cancel_provider_payment_id, expiration_last_error, final_amount, payment_method').eq('order_id', orderId).single();
    if (error) throw new Error(JSON.stringify(error));
    return data;
  }

  async function runWorker(gateway) {
    return expireAndCancelStaleCheckoutPayments({
      supabase: service,
      organizationId: org.id,
      limit: 20,
      getGateway: () => gateway,
    });
  }

  return { service, org, must, makeCase, startCard, paymentOf, runWorker };
}

const fx = await buildFixture();

describe('p2 card checkout hold', { concurrency: 1 }, () => {
test('cartao a vista pending vence: todas as charges invalidas, estoque libera, hold UI=writer', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const started = await fx.startCard(created.orderId);
  const held = await scene.uiStock();
  assert.equal(held.available, 0);
  assert.equal(held.checkoutHold, 1);
  assert.equal(held.writerAvailable, 0);
  await backdateShortCheckoutHold(fx.service, created.orderId);
  const tracked = trackingGateway();
  const result = await scene.runWorker(tracked.gateway);
  assert.equal(result.expired >= 1, true);
  assert.deepEqual([...tracked.cancelled].sort(), [...started.chargeIds].sort());
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'expired');
  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', created.orderId);
  assert.equal((tickets ?? []).length, 0);
  const stock = await scene.uiStock();
  assert.equal(stock.available, 1);
  assert.equal(stock.checkoutHold, 0);
  assert.equal(stock.writerAvailable, 1);
});

test('cartao parcelado pending vence e cancela todas as charges do installment', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const started = await fx.startCard(created.orderId, { installments: 3 });
  assert.equal(started.chargeIds.length, 3);
  await backdateShortCheckoutHold(fx.service, created.orderId);
  const tracked = trackingGateway();
  const result = await scene.runWorker(tracked.gateway);
  assert.equal(result.expired >= 1, true);
  assert.equal(tracked.cancelled.size, 3);
  assert.deepEqual([...tracked.cancelled].sort(), [...started.chargeIds].sort());
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'expired');
  const stock = await scene.uiStock();
  assert.equal(stock.available, 1);
  assert.equal(stock.checkoutHold, 0);
});

test('pagamento CONFIRMED ganha a corrida: nao cancela, emite um ticket, sem oversell', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const started = await fx.startCard(created.orderId);
  await backdateShortCheckoutHold(fx.service, created.orderId);
  const tracked = trackingGateway({ paidIds: new Set(started.chargeIds) });
  const result = await scene.runWorker(tracked.gateway);
  assert.equal(tracked.cancelled.size, 0);
  assert.equal(result.paid >= 1, true);
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'paid');
  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', created.orderId);
  assert.equal((tickets ?? []).length, 1);
  const stock = await scene.uiStock();
  assert.equal(stock.available, 0);
  assert.equal(stock.checkoutHold, 0);
});

test('DELETE parcial / timeout: estoque permanece reserved', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const started = await fx.startCard(created.orderId, { installments: 3 });
  await backdateShortCheckoutHold(fx.service, created.orderId);
  let cancelCalls = 0;
  const tracked = trackingGateway({
    onCancel: async (input, cancelled) => {
      cancelCalls += 1;
      if (cancelCalls >= 2) throw new GatewayTimeoutError('Timeout ao chamar Asaas (/payments/id).');
      cancelled.add(input.providerPaymentId);
    },
  });
  const result = await scene.runWorker(tracked.gateway);
  assert.equal(result.failed >= 1, true);
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'pending');
  const stock = await scene.uiStock();
  assert.equal(stock.available, 0);
  assert.equal(stock.checkoutHold, 1);
  assert.ok(started.chargeIds.length === 3);
});

test('worker cai apos cancelar parte do parcelamento e retry converge sem liberar cedo', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const started = await fx.startCard(created.orderId, { installments: 3 });
  await backdateShortCheckoutHold(fx.service, created.orderId);
  let cancelCalls = 0;
  const tracked = trackingGateway({
    onCancel: async (input, cancelled) => {
      cancelCalls += 1;
      cancelled.add(input.providerPaymentId);
      if (cancelCalls === 2) throw new Error('worker crash apos DELETE parcial');
    },
  });
  const first = await scene.runWorker(tracked.gateway);
  assert.equal(first.failed >= 1, true);
  const mid = await fx.paymentOf(created.orderId);
  assert.equal(mid.payment_status, 'pending');
  const held = await scene.uiStock();
  assert.equal(held.available, 0);
  assert.equal(held.checkoutHold, 1);
  assert.equal(tracked.cancelled.size >= 1, true);
  assert.ok(tracked.cancelled.size < 3);

  const retry = await scene.runWorker(tracked.gateway);
  assert.equal(retry.expired >= 1, true);
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'expired');
  assert.deepEqual([...tracked.cancelled].sort(), [...started.chargeIds].sort());
  const stock = await scene.uiStock();
  assert.equal(stock.available, 1);
  assert.equal(stock.checkoutHold, 0);
  assert.equal(stock.writerAvailable, 1);
});

test('worker duas vezes e charge ja deletada: idempotente; estoque libera uma vez', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const started = await fx.startCard(created.orderId);
  await backdateShortCheckoutHold(fx.service, created.orderId);
  const first = await scene.runWorker({
    getPayment: async () => {
      throw new AsaasApiError(`/payments/${started.rootId}`, 404, 'HTTP 404');
    },
  });
  assert.equal(first.expired >= 1, true);
  const second = await scene.runWorker({
    getPayment: async () => pendingSnapshot(started.rootId),
    cancelPayment: async () => { throw new Error('nao deve cancelar de novo'); },
  });
  assert.equal(second.claimed, 0);
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'expired');
  const stock = await scene.uiStock();
  assert.equal(stock.available, 1);
});

test('uma parcela inesperadamente CONFIRMED: nao DELETE das demais; reconcilia venda', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const started = await fx.startCard(created.orderId, { installments: 3 });
  await backdateShortCheckoutHold(fx.service, created.orderId);
  const paidId = started.chargeIds[1];
  const amounts = Object.fromEntries(started.charges.map((row) => [row.gateway_payment_id, row.amount]));
  const tracked = trackingGateway({ paidIds: new Set([paidId]), amounts });
  const result = await scene.runWorker(tracked.gateway);
  assert.equal(tracked.cancelled.size, 0);
  assert.equal(result.paid >= 1, true);
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'paid');
  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', created.orderId);
  assert.equal((tickets ?? []).length, 1);
});

test('webhook analogo durante cancelamento: inspectionsAfter pago reconcilia venda', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  await fx.startCard(created.orderId);
  await backdateShortCheckoutHold(fx.service, created.orderId);
  let sawCancel = false;
  const result = await scene.runWorker({
    getPayment: async (input) => (sawCancel ? paidSnapshot(input.providerPaymentId) : pendingSnapshot(input.providerPaymentId)),
    cancelPayment: async () => { sawCancel = true; },
  });
  assert.equal(result.paid >= 1, true);
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'paid');
  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', created.orderId);
  assert.equal((tickets ?? []).length, 1);
});

test('cancelamento ganha a corrida: GET pending, DELETE, GET DELETED, estoque libera', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  const started = await fx.startCard(created.orderId);
  await backdateShortCheckoutHold(fx.service, created.orderId);
  const tracked = trackingGateway();
  const result = await scene.runWorker(tracked.gateway);
  assert.equal(result.expired >= 1, true);
  assert.deepEqual([...tracked.cancelled].sort(), [...started.chargeIds].sort());
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'expired');
  const stock = await scene.uiStock();
  assert.equal(stock.available, 1);
  assert.equal(stock.checkoutHold, 0);
});

test('GET 5xx: estoque permanece reserved e hold consumido', async () => {
  const scene = await fx.makeCase();
  const created = await scene.checkout();
  assert.equal(created.error, null, created.error?.message);
  await fx.startCard(created.orderId);
  await backdateShortCheckoutHold(fx.service, created.orderId);
  const result = await scene.runWorker({
    getPayment: async (input) => {
      throw new AsaasApiError(`/payments/${input.providerPaymentId}`, 503, 'HTTP 503');
    },
  });
  assert.equal(result.failed >= 1, true);
  const pay = await fx.paymentOf(created.orderId);
  assert.equal(pay.payment_status, 'pending');
  const stock = await scene.uiStock();
  assert.equal(stock.available, 0);
  assert.equal(stock.checkoutHold, 1);
});
});
