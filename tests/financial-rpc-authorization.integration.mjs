import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

function generateValidCpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  function digit(values) {
    let sum = 0;
    let weight = values.length + 1;
    for (const value of values) {
      sum += value * weight;
      weight -= 1;
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  }
  const first = digit(base);
  return [...base, first, digit([...base, first])].join('');
}

async function environment() {
  const text = await readFile(new URL('../.env.local', import.meta.url), 'utf8').catch(() => '');
  const local = Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
      }),
  );
  return {
    url: 'http://127.0.0.1:54321',
    anonKey:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    serviceKey:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
    ...local,
  };
}

async function buildFixture() {
  const env = await environment();
  const service = createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anonymous = createClient(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }

  async function createUserClient(prefix) {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const email = `${prefix}-${suffix}@qa.local`;
    const password = 'SenhaForte!123';
    const created = await must(
      service.auth.admin.createUser({ email, password, email_confirm: true }),
      `create ${prefix}`,
    );
    await must(
      service.from('customer_profiles').upsert(
        {
          user_id: created.user.id,
          cpf: generateValidCpf(),
          full_name: prefix,
          birth_date: '1990-05-05',
          phone: '11999990001',
          city: 'Itapiranga',
          gender: 'male',
        },
        { onConflict: 'user_id' },
      ),
      `profile ${prefix}`,
    );
    const client = createClient(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await must(client.auth.signInWithPassword({ email, password }), `login ${prefix}`);
    return { client, userId: created.user.id, email };
  }

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const orgA = await must(
    service
      .from('organizations')
      .insert({ name: `Financial P0 A ${suffix}`, slug: `financial-p0-a-${suffix}` })
      .select('id')
      .single(),
    'org A',
  );
  const orgB = await must(
    service
      .from('organizations')
      .insert({ name: `Financial P0 B ${suffix}`, slug: `financial-p0-b-${suffix}` })
      .select('id')
      .single(),
    'org B',
  );
  const buyer = await createUserClient('buyer-p0');
  const outsider = await createUserClient('outsider-p0');
  const adminA = await createUserClient('admin-a-p0');
  const adminB = await createUserClient('admin-b-p0');
  const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');

  await must(
    service.from('organization_members').insert([
      { organization_id: orgA.id, user_id: adminA.userId, is_owner: true, is_active: true },
      { organization_id: orgB.id, user_id: adminB.userId, is_owner: true, is_active: true },
    ]),
    'memberships',
  );
  await must(
    service.from('admin_users').insert([
      { user_id: adminA.userId, role_id: ownerRole.id, is_active: true },
      { user_id: adminB.userId, role_id: ownerRole.id, is_active: true },
    ]),
    'admin users',
  );

  const event = await must(
    service
      .from('events')
      .insert({
        organization_id: orgA.id,
        name: `Financial P0 Event ${suffix}`,
        year: 2026,
        slug: `financial-p0-event-${suffix}`,
        is_active: true,
        registration_enabled: true,
        starts_at: '2026-11-21T12:00:00-03:00',
        min_age: 0,
      })
      .select('id')
      .single(),
    'event',
  );
  const batch = await must(
    service
      .from('registration_batches')
      .insert({
        event_id: event.id,
        name: 'Lote P0',
        sequence_number: 1,
        male_price: 100,
        female_price: 100,
        max_confirmed_registrations: 500,
        is_active: true,
      })
      .select('id')
      .single(),
    'batch',
  );
  const category = await must(
    service
      .from('ticket_categories')
      .insert({
        event_id: event.id,
        name: 'Geral P0',
        slug: `geral-p0-${suffix}`,
        sort_order: 1,
        is_active: true,
      })
      .select('id')
      .single(),
    'category',
  );
  await must(
    service.from('registration_batch_prices').insert({
      batch_id: batch.id,
      ticket_category_id: category.id,
      male_price: 100,
      female_price: 100,
    }),
    'price',
  );

  async function createOrder() {
    const cpf = generateValidCpf();
    const result = await must(
      buyer.client.rpc('create_multi_ticket_order_checkout', {
        p_event_id: event.id,
        p_ticket_category_id: category.id,
        p_gender: 'male',
        p_quantity: 1,
        p_payment_method: 'pix',
        p_buyer_full_name: 'Buyer P0',
        p_buyer_cpf: cpf,
        p_buyer_birth_date: '1990-05-05',
        p_buyer_gender: 'male',
        p_buyer_phone: '11999990001',
        p_buyer_email: buyer.email,
        p_buyer_city: 'Itapiranga',
        p_assign_first_to_buyer: true,
        p_items: [{ ownership_mode: 'self' }],
        p_client_request_id: `financial-p0-${Date.now()}-${Math.random()}`,
      }),
      'create order',
    );
    const row = Array.isArray(result) ? result[0] : result;
    const item = await must(
      service
        .from('order_items')
        .select('id,participant_id')
        .eq('order_id', row.order_id)
        .single(),
      'order item',
    );
    const payment = await must(
      service
        .from('payments')
        .select('id,payment_status,gateway_payment_id,pix_code')
        .eq('order_id', row.order_id)
        .single(),
      'payment',
    );
    return { orderId: row.order_id, itemId: item.id, participantId: item.participant_id, payment };
  }

  async function createStoreOrder() {
    return must(
      service
        .from('store_orders')
        .insert({
          organization_id: orgA.id,
          event_id: event.id,
          user_id: buyer.userId,
          order_number: `STORE-P0-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
          status: 'pending',
          payment_status: 'pending',
          payment_method: 'pix',
          base_amount: 50,
          final_amount: 50,
        })
        .select('id,status,payment_status,gateway_payment_id,pix_code')
        .single(),
      'store order',
    );
  }

  return {
    service,
    anonymous,
    buyer,
    outsider,
    adminA,
    adminB,
    orgA,
    event,
    must,
    createUserClient,
    createOrder,
    createStoreOrder,
  };
}

const fx = await buildFixture();

test('anon e authenticated nao executam simuladores legados nem helpers de emissao', async () => {
  const order = await fx.createOrder();
  const calls = [
    ['simulate_order_payment_paid', { p_order_id: order.orderId, p_payment_method: 'pix' }],
    ['simulate_payment_paid', { p_participant_id: order.participantId, p_payment_method: 'pix' }],
    ['confirm_order_payment_and_issue_tickets', { p_order_id: order.orderId }],
    ['confirm_order_item_and_issue_ticket', { p_order_item_id: order.itemId }],
    ['confirm_registration_payment', { p_participant_id: order.participantId }],
    ['confirm_order_and_issue_ticket', { p_participant_id: order.participantId }],
  ];
  for (const [name, args] of calls) {
    assert.ok((await fx.anonymous.rpc(name, args)).error, `anon deveria ser negado em ${name}`);
    assert.ok((await fx.outsider.client.rpc(name, args)).error, `authenticated deveria ser negado em ${name}`);
  }

  const payment = await fx.must(
    fx.service.from('payments').select('payment_status').eq('id', order.payment.id).single(),
    'payment after denied simulations',
  );
  const currentOrder = await fx.must(
    fx.service.from('orders').select('status').eq('id', order.orderId).single(),
    'order after denied simulations',
  );
  const tickets = await fx.must(
    fx.service.from('tickets').select('id').eq('order_id', order.orderId),
    'tickets after denied simulations',
  );
  assert.equal(payment.payment_status, 'pending');
  assert.equal(currentOrder.status, 'pending');
  assert.equal(tickets.length, 0);
});

test('anon nao adultera PIX e usuario nao inicia PIX de pedido alheio', async () => {
  const order = await fx.createOrder();
  const args = {
    p_order_id: order.orderId,
    p_pix_code: 'ATTACKER-PIX',
    p_pix_qrcode: 'ATTACKER-QR',
    p_gateway_payment_id: `attacker-${Date.now()}`,
    p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    p_provider: 'fake',
  };
  assert.ok((await fx.anonymous.rpc('start_order_payment_pix', args)).error);
  assert.ok((await fx.outsider.client.rpc('start_order_payment_pix', args)).error);

  const payment = await fx.must(
    fx.service
      .from('payments')
      .select('payment_status,gateway_payment_id,pix_code')
      .eq('id', order.payment.id)
      .single(),
    'payment after denied pix',
  );
  assert.equal(payment.payment_status, 'pending');
  assert.equal(payment.gateway_payment_id, null);
  assert.equal(payment.pix_code, null);
});

test('PIX participant-centric rejeita anon/terceiro e permite o proprio usuario', async () => {
  const order = await fx.createOrder();
  const args = {
    p_participant_id: order.participantId,
    p_pix_code: 'PARTICIPANT-PIX',
    p_pix_qrcode: 'PARTICIPANT-QR',
    p_gateway_payment_id: `participant-p0-${Date.now()}`,
    p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    p_provider: 'fake',
  };
  assert.ok((await fx.anonymous.rpc('start_payment_pix', args)).error);
  assert.ok((await fx.outsider.client.rpc('start_payment_pix', args)).error);
  assert.equal(
    (
      await fx.must(
        fx.service.from('payments').select('gateway_payment_id').eq('id', order.payment.id).single(),
        'participant pix unchanged',
      )
    ).gateway_payment_id,
    null,
  );

  await fx.must(fx.buyer.client.rpc('start_payment_pix', args), 'owner participant pix');
  assert.equal(
    (
      await fx.must(
        fx.service.from('payments').select('gateway_payment_id').eq('id', order.payment.id).single(),
        'participant pix owner update',
      )
    ).gateway_payment_id,
    args.p_gateway_payment_id,
  );
});

test('comprador inicia o proprio PIX e gateway fake canonico emite exatamente um ticket', async () => {
  const order = await fx.createOrder();
  const gatewayPaymentId = `fake-p0-${Date.now()}-${Math.random()}`;
  await fx.must(
    fx.buyer.client.rpc('start_order_payment_pix', {
      p_order_id: order.orderId,
      p_pix_code: 'BUYER-PIX',
      p_pix_qrcode: 'BUYER-QR',
      p_gateway_payment_id: gatewayPaymentId,
      p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      p_provider: 'fake',
    }),
    'buyer start pix',
  );
  await fx.must(
    fx.buyer.client.rpc('simulate_fake_gateway_payment_paid', { p_order_id: order.orderId }),
    'canonical fake simulation',
  );

  const payment = await fx.must(
    fx.service.from('payments').select('payment_status').eq('id', order.payment.id).single(),
    'paid payment',
  );
  const currentOrder = await fx.must(
    fx.service.from('orders').select('status').eq('id', order.orderId).single(),
    'confirmed order',
  );
  const tickets = await fx.must(
    fx.service.from('tickets').select('id,status').eq('order_id', order.orderId),
    'issued tickets',
  );
  assert.equal(payment.payment_status, 'paid');
  assert.equal(currentOrder.status, 'confirmed');
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].status, 'active');
  assert.ok(
    (
      await fx.anonymous.rpc('get_ticket_payment_operational_status', {
        p_ticket_id: tickets[0].id,
      })
    ).error,
  );
  const operational = await fx.must(
    fx.adminA.client.rpc('get_ticket_payment_operational_status', {
      p_ticket_id: tickets[0].id,
    }),
    'operational payment status',
  );
  assert.equal((Array.isArray(operational) ? operational[0] : operational).payment_status, 'paid');
});

test('get_participant_payment_details bloqueia IDOR e permite dono/financeiro da organizacao', async () => {
  const order = await fx.createOrder();
  const args = { p_participant_id: order.participantId };
  assert.ok((await fx.anonymous.rpc('get_participant_payment_details', args)).error);
  assert.ok((await fx.outsider.client.rpc('get_participant_payment_details', args)).error);
  assert.ok((await fx.adminB.client.rpc('get_participant_payment_details', args)).error);

  const own = await fx.must(
    fx.buyer.client.rpc('get_participant_payment_details', args),
    'owner payment details',
  );
  const admin = await fx.must(
    fx.adminA.client.rpc('get_participant_payment_details', args),
    'same-org finance payment details',
  );
  assert.equal((Array.isArray(own) ? own[0] : own).payment_id, order.payment.id);
  assert.equal((Array.isArray(admin) ? admin[0] : admin).payment_id, order.payment.id);
});

test('admin_update_payment_status exige permissao e organizacao e preserva emissao legitima', async () => {
  const deniedOrder = await fx.createOrder();
  const deniedArgs = {
    p_payment_id: deniedOrder.payment.id,
    p_participant_id: deniedOrder.participantId,
    p_expected_current_status: 'pending',
    p_new_status: 'paid',
    p_reason: 'Tentativa de outra organizacao',
  };
  const outsiderResult = await fx.must(
    fx.outsider.client.rpc('admin_update_payment_status', deniedArgs),
    'outsider admin update result',
  );
  const crossOrgResult = await fx.must(
    fx.adminB.client.rpc('admin_update_payment_status', deniedArgs),
    'cross-org admin update result',
  );
  assert.equal(outsiderResult.success, false);
  assert.equal(crossOrgResult.success, false);
  assert.equal(
    (
      await fx.must(
        fx.service.from('payments').select('payment_status').eq('id', deniedOrder.payment.id).single(),
        'denied payment state',
      )
    ).payment_status,
    'pending',
  );
  assert.equal(
    (await fx.must(fx.service.from('tickets').select('id').eq('order_id', deniedOrder.orderId), 'denied tickets')).length,
    0,
  );

  const allowedOrder = await fx.createOrder();
  const allowed = await fx.must(
    fx.adminA.client.rpc('admin_update_payment_status', {
      p_payment_id: allowedOrder.payment.id,
      p_participant_id: allowedOrder.participantId,
      p_expected_current_status: 'pending',
      p_new_status: 'paid',
      p_reason: 'Confirmacao administrativa no teste P0',
    }),
    'same-org admin update',
  );
  assert.equal(allowed.success, true);
  assert.equal(
    (
      await fx.must(
        fx.service.from('payments').select('payment_status').eq('id', allowedOrder.payment.id).single(),
        'allowed payment state',
      )
    ).payment_status,
    'paid',
  );
  assert.equal(
    (await fx.must(fx.service.from('tickets').select('id').eq('order_id', allowedOrder.orderId), 'allowed tickets')).length,
    1,
  );
});

test('loja nao e confirmada nem tem PIX adulterado por anon/outsider; backend de teste continua funcional', async () => {
  const storeOrder = await fx.createStoreOrder();
  const startArgs = {
    p_store_order_id: storeOrder.id,
    p_pix_code: 'ATTACKER-STORE-PIX',
    p_pix_qrcode: 'ATTACKER-STORE-QR',
    p_gateway_payment_id: `attacker-store-${Date.now()}`,
    p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
  assert.ok((await fx.anonymous.rpc('start_store_order_payment_pix', startArgs)).error);
  assert.ok((await fx.outsider.client.rpc('start_store_order_payment_pix', startArgs)).error);
  assert.ok(
    (
      await fx.anonymous.rpc('simulate_store_order_payment', {
        p_store_order_id: storeOrder.id,
        p_payment_method: 'pix',
      })
    ).error,
  );
  assert.ok(
    (
      await fx.outsider.client.rpc('simulate_store_order_payment', {
        p_store_order_id: storeOrder.id,
        p_payment_method: 'pix',
      })
    ).error,
  );
  assert.ok(
    (
      await fx.anonymous.rpc('cancel_store_order', {
        p_store_order_id: storeOrder.id,
        p_reason: 'ataque',
      })
    ).error,
  );

  let current = await fx.must(
    fx.service
      .from('store_orders')
      .select('status,payment_status,gateway_payment_id,pix_code')
      .eq('id', storeOrder.id)
      .single(),
    'store unchanged',
  );
  assert.equal(current.status, 'pending');
  assert.equal(current.payment_status, 'pending');
  assert.equal(current.gateway_payment_id, null);
  assert.equal(current.pix_code, null);

  await fx.must(
    fx.buyer.client.rpc('start_store_order_payment_pix', {
      ...startArgs,
      p_pix_code: 'BUYER-STORE-PIX',
      p_gateway_payment_id: `buyer-store-${Date.now()}`,
    }),
    'buyer start store pix',
  );
  await fx.must(
    fx.service.rpc('simulate_store_order_payment', {
      p_store_order_id: storeOrder.id,
      p_payment_method: 'pix',
    }),
    'service store simulation',
  );
  current = await fx.must(
    fx.service.from('store_orders').select('status,payment_status').eq('id', storeOrder.id).single(),
    'store confirmed',
  );
  assert.equal(current.status, 'confirmed');
  assert.equal(current.payment_status, 'paid');
});

test('anon nao cancela pagamento participant-centric e comprador ainda pode cancelar o proprio pendente', async () => {
  const order = await fx.createOrder();
  const args = { p_participant_id: order.participantId, p_reason: 'cancelamento P0' };
  assert.ok((await fx.anonymous.rpc('cancel_registration_payment', args)).error);
  assert.ok((await fx.outsider.client.rpc('cancel_registration_payment', args)).error);
  assert.equal(
    (
      await fx.must(
        fx.service.from('payments').select('payment_status').eq('id', order.payment.id).single(),
        'payment before owner cancel',
      )
    ).payment_status,
    'pending',
  );
  await fx.must(fx.buyer.client.rpc('cancel_registration_payment', args), 'owner cancellation');
  assert.equal(
    (
      await fx.must(
        fx.service.from('payments').select('payment_status').eq('id', order.payment.id).single(),
        'payment after owner cancel',
      )
    ).payment_status,
    'cancelled',
  );
});

test('webhook/gateway permanece service-only e confirma legitimamente', async () => {
  const order = await fx.createOrder();
  const gatewayPaymentId = `asaas-p0-${Date.now()}-${Math.random()}`;
  await fx.must(
    fx.buyer.client.rpc('start_order_payment_pix', {
      p_order_id: order.orderId,
      p_pix_code: 'ASAAS-P0-PIX',
      p_pix_qrcode: 'ASAAS-P0-QR',
      p_gateway_payment_id: gatewayPaymentId,
      p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      p_provider: 'asaas',
    }),
    'start asaas pix',
  );
  const gatewayArgs = {
    p_provider: 'asaas',
    p_provider_payment_id: gatewayPaymentId,
    p_provider_status: 'CONFIRMED',
    p_internal_status: 'paid',
  };
  assert.ok((await fx.anonymous.rpc('apply_gateway_payment_status', gatewayArgs)).error);
  assert.ok((await fx.buyer.client.rpc('apply_gateway_payment_status', gatewayArgs)).error);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', gatewayArgs), 'service gateway paid');
  assert.equal(
    (await fx.must(fx.service.from('tickets').select('id').eq('order_id', order.orderId), 'gateway tickets')).length,
    1,
  );
});

async function payOrderAsBuyer(orderId, label) {
  const gatewayPaymentId = `owner-status-${Date.now()}-${Math.random()}`;
  await fx.must(
    fx.buyer.client.rpc('start_order_payment_pix', {
      p_order_id: orderId,
      p_pix_code: `PIX-${label}`,
      p_pix_qrcode: `QR-${label}`,
      p_gateway_payment_id: gatewayPaymentId,
      p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      p_provider: 'fake',
    }),
    `start pix ${label}`,
  );
  await fx.must(
    fx.buyer.client.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId }),
    `pay ${label}`,
  );
}

test('status operacional de pagamento libera owner_user_id e bloqueia IDOR/anon', async () => {
  const order = await fx.createOrder();
  await payOrderAsBuyer(order.orderId, 'owner-status');
  const tickets = await fx.must(
    fx.service.from('tickets').select('id, owner_user_id').eq('order_id', order.orderId),
    'owned tickets',
  );
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].owner_user_id, fx.buyer.userId);
  const ticketId = tickets[0].id;

  assert.ok((await fx.anonymous.rpc('get_ticket_payment_operational_status', { p_ticket_id: ticketId })).error);
  assert.ok((await fx.outsider.client.rpc('get_ticket_payment_operational_status', { p_ticket_id: ticketId })).error);
  assert.ok((await fx.anonymous.rpc('get_my_tickets_payment_operational_status')).error);

  const ownerStatus = await fx.must(
    fx.buyer.client.rpc('get_ticket_payment_operational_status', { p_ticket_id: ticketId }),
    'owner operational status',
  );
  assert.equal((Array.isArray(ownerStatus) ? ownerStatus[0] : ownerStatus).payment_status, 'paid');

  const mine = await fx.must(
    fx.buyer.client.rpc('get_my_tickets_payment_operational_status'),
    'owner batch operational status',
  );
  const mineRows = Array.isArray(mine) ? mine : [mine];
  assert.equal(mineRows.some((row) => row.ticket_id === ticketId && row.payment_status === 'paid'), true);

  const outsiderMine = await fx.must(
    fx.outsider.client.rpc('get_my_tickets_payment_operational_status'),
    'outsider batch operational status',
  );
  const outsiderRows = Array.isArray(outsiderMine) ? outsiderMine : outsiderMine ? [outsiderMine] : [];
  assert.equal(outsiderRows.some((row) => row.ticket_id === ticketId), false);
});

test('owner_user_id le status pago de 3 tickets com titulares distintos', async () => {
  const maria = await fx.createUserClient('maria-fam');
  const ticketIds = [];
  for (const holder of ['Joao', 'Maria', 'Pedro']) {
    const order = await fx.createOrder();
    await payOrderAsBuyer(order.orderId, holder);
    const tickets = await fx.must(
      fx.service.from('tickets').select('id').eq('order_id', order.orderId),
      `tickets ${holder}`,
    );
    await fx.must(
      fx.service.from('tickets').update({ owner_user_id: maria.userId }).eq('id', tickets[0].id),
      `assign owner ${holder}`,
    );
    ticketIds.push(tickets[0].id);
  }

  const mine = await fx.must(
    maria.client.rpc('get_my_tickets_payment_operational_status'),
    'maria family operational status',
  );
  const mineRows = Array.isArray(mine) ? mine : [mine];
  for (const ticketId of ticketIds) {
    assert.equal(
      mineRows.some((row) => row.ticket_id === ticketId && row.payment_status === 'paid'),
      true,
      `Maria deve ver paid no ticket ${ticketId}`,
    );
  }

  assert.ok(
    (await fx.outsider.client.rpc('get_ticket_payment_operational_status', { p_ticket_id: ticketIds[0] })).error,
    'conhecer o ticket_id nao basta',
  );
  assert.ok(
    (await fx.anonymous.rpc('get_ticket_payment_operational_status', { p_ticket_id: ticketIds[0] })).error,
    'anon nao acessa status operacional',
  );
});
