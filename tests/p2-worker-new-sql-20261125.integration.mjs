import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { resolveLocalSupabase } from './helpers/local-supabase-env.mjs';
import { backdateShortCheckoutHold } from './helpers/expire-asaas-pix-cycle.mjs';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

const { expireAndCancelStaleCheckoutPayments } = await import('../src/lib/payments/expire-and-cancel-stale.ts');

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pixOnlySql = path.join(root, 'tests/helpers/sql-20261125-pix-only-expire-claim.sql');
const sql26 = path.join(root, 'supabase/migrations/20261126000000_unified_10min_card_checkout_hold.sql');

import { readFileSync } from 'node:fs';

function applyLocalSql(file) {
  execFileSync(
    'docker',
    ['exec', '-i', 'supabase_db_militrin-manager', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    { cwd: root, stdio: ['pipe', 'inherit', 'inherit'], input: readFileSync(file) },
  );
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

test('Fase A: worker novo + claim PIX-only nao toca cartao e processa PIX', async (t) => {
  applyLocalSql(pixOnlySql);
  t.after(() => applyLocalSql(sql26));

  const env = await resolveLocalSupabase();
  const service = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const password = 'SenhaForte!123';
  const org = await must(service.from('organizations').insert({
    name: `P2 Compat ${suffix}`, slug: `p2-compat-${suffix}`,
  }).select('id').single(), 'org');
  const buyerEmail = `p2-compat-${suffix}@qa.local`;
  const buyerCreated = await must(service.auth.admin.createUser({
    email: buyerEmail, password, email_confirm: true,
  }), 'buyer');
  await must(service.from('customer_profiles').upsert({
    user_id: buyerCreated.user.id, cpf: generateValidCpf(), full_name: 'Comprador Compat',
    birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'female',
  }, { onConflict: 'user_id' }), 'profile');
  const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
  await must(service.from('organization_members').insert({
    organization_id: org.id, user_id: buyerCreated.user.id, is_owner: true, is_active: true,
  }), 'member');
  await must(service.from('admin_users').insert({
    user_id: buyerCreated.user.id, role_id: ownerRole.id, is_active: true,
  }), 'admin');
  const buyer = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await buyer.auth.signInWithPassword({ email: buyerEmail, password });
  if (signIn.error) throw new Error(`login: ${signIn.error.message}`);

  async function makeEvent(tag) {
    const event = await must(service.from('events').insert({
      organization_id: org.id,
      name: `P2 Compat ${tag} ${suffix}`,
      year: 2026,
      slug: `p2-compat-${tag}-${suffix}`,
      is_active: true,
      registration_enabled: true,
      starts_at: '2026-11-21T12:00:00-03:00',
      min_age: 0,
      kit_enabled: true,
      limit_shirt_selection_to_stock: true,
    }).select('id').single(), `event ${tag}`);
    const batch = await must(service.from('registration_batches').insert({
      event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 175, female_price: 175,
      max_confirmed_registrations: 500, is_active: true,
    }).select('id').single(), `batch ${tag}`);
    const category = await must(service.from('ticket_categories').insert({
      event_id: event.id, name: 'Geral', slug: `geral-compat-${tag}-${suffix}`,
      sort_order: 1, is_active: true,
    }).select('id').single(), `category ${tag}`);
    await must(service.from('registration_batch_prices').insert({
      batch_id: batch.id, ticket_category_id: category.id, male_price: 175, female_price: 175,
    }), `price ${tag}`);
    await must(service.from('shirt_inventory').insert({
      event_id: event.id, organization_id: org.id, shirt_type: 'Babylook', shirt_size: 'M', total_quantity: 1,
    }), `shirt ${tag}`);
    const kitItem = await must(service.from('event_kit_items').insert({
      organization_id: org.id, event_id: event.id, name: 'Camiseta', slug: `camiseta-compat-${tag}-${suffix}`,
      item_type: 'shirt', requires_variant: true, is_required: false, is_active: true, shirt_supply_mode: 'stock',
    }).select('id').single(), `kit ${tag}`);
    const variantM = await must(service.from('event_kit_item_variants').insert({
      kit_item_id: kitItem.id, name: 'Babylook', value: 'M', is_active: true, sort_order: 1,
    }).select('id').single(), `variant ${tag}`);
    await must(service.from('event_kit_item_variant_inventory').insert({
      organization_id: org.id, event_id: event.id, kit_item_id: kitItem.id, variant_id: variantM.id, total_quantity: 1,
    }), `kit inv ${tag}`);
    return { event, category };
  }

  async function checkout(event, category, method) {
    const r = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id,
      p_ticket_category_id: category.id,
      p_gender: 'female',
      p_quantity: 1,
      p_payment_method: method,
      p_buyer_full_name: 'Comprador Compat',
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
      p_client_request_id: `p2-compat-${method}-${Date.now()}-${Math.random()}`,
    });
    if (r.error) throw new Error(`checkout ${method}: ${r.error.message}`);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return row.order_id;
  }

  async function paymentOf(orderId) {
    const { data, error } = await service.from('payments').select(
      'id, payment_status, payment_method, pending_cancel_provider_payment_id, expiration_lease_until, gateway_payment_id',
    ).eq('order_id', orderId).single();
    if (error) throw error;
    return data;
  }

  const pixEvent = await makeEvent('pix');
  const cardEvent = await makeEvent('card');
  const pixOrderId = await checkout(pixEvent.event, pixEvent.category, 'pix');
  const cardOrderId = await checkout(cardEvent.event, cardEvent.category, 'credit_card');

  const pixId = `pay_pix_${suffix}`;
  const cardId = `pay_card_${suffix}`;
  await must(buyer.rpc('start_order_payment_pix', {
    p_order_id: pixOrderId,
    p_pix_code: '00020126fake',
    p_pix_qrcode: 'data:image/png;base64,ZmFrZQ==',
    p_gateway_payment_id: pixId,
    p_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    p_provider: 'asaas',
    p_gateway_account_key: 'militrin-pix',
    p_payment_method: 'pix',
  }), 'start pix');
  await must(buyer.rpc('start_order_payment_pix', {
    p_order_id: cardOrderId,
    p_pix_code: '',
    p_pix_qrcode: '',
    p_gateway_payment_id: cardId,
    p_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    p_provider: 'asaas',
    p_gateway_account_key: 'militrin-card',
    p_payment_method: 'credit_card',
    p_checkout_url: `https://checkout.invalid/${cardId}`,
    p_gateway_charges: [{
      gateway_payment_id: cardId,
      installment_number: 1,
      installment_count: 1,
      amount: 175,
    }],
  }), 'start card');

  await backdateShortCheckoutHold(service, pixOrderId);
  await backdateShortCheckoutHold(service, cardOrderId);

  const cardBefore = await paymentOf(cardOrderId);
  await must(service.from('payments').update({
    pending_cancel_provider: 'asaas',
    pending_cancel_provider_payment_id: cardBefore.gateway_payment_id,
  }).eq('id', cardBefore.id), 'force card pending_cancel');

  const cancelled = [];
  const result = await expireAndCancelStaleCheckoutPayments({
    supabase: service,
    organizationId: org.id,
    limit: 20,
    getGateway: () => ({
      getPayment: async (input) => ({
        providerPaymentId: input.providerPaymentId,
        status: 'pending',
        providerStatus: 'PENDING',
        paidAt: null,
        feeAmount: null,
        netAmount: null,
        amount: 175,
      }),
      cancelPayment: async (input) => { cancelled.push(input.providerPaymentId); },
    }),
  });

  const pixAfter = await paymentOf(pixOrderId);
  const cardAfter = await paymentOf(cardOrderId);
  assert.equal(result.expired >= 1, true);
  assert.equal(pixAfter.payment_status, 'expired');
  assert.deepEqual(cancelled, [pixId]);
  assert.equal(cardAfter.payment_status, 'pending');
  assert.equal(cardAfter.pending_cancel_provider_payment_id, cardId);
  assert.equal(cardAfter.expiration_lease_until, null);
  assert.ok(!cancelled.includes(cardId));

  const cardStock = await must(service.rpc('get_event_shirt_stock_for_selection', {
    p_event_id: cardEvent.event.id,
  }), 'card stock');
  const cardRow = (cardStock ?? []).find((row) => row.shirt_type === 'Babylook' && row.shirt_size === 'M');
  assert.equal(Number(cardRow?.checkout_hold_quantity ?? 0), 1);
  assert.equal(Number(cardRow?.available_quantity ?? 0), 0);

  const pixStock = await must(service.rpc('get_event_shirt_stock_for_selection', {
    p_event_id: pixEvent.event.id,
  }), 'pix stock');
  const pixRow = (pixStock ?? []).find((row) => row.shirt_type === 'Babylook' && row.shirt_size === 'M');
  assert.equal(Number(pixRow?.checkout_hold_quantity ?? 0), 0);
  assert.equal(Number(pixRow?.available_quantity ?? 0), 1);
});
