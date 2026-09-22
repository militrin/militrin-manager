import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

const HOTFIX = 'supabase/migrations/20261027000000_fix_store_gateway_status_ambiguous_columns.sql';
const LOCAL_URL = 'http://127.0.0.1:15421';
const LOCAL_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

function functionBody(sql) {
  const start = sql.indexOf('create or replace function public.apply_store_order_gateway_status');
  assert.notEqual(start, -1, 'hotfix deve substituir apply_store_order_gateway_status');
  const dollar = sql.indexOf('as $$', start);
  const end = sql.indexOf('\n$$;', dollar);
  return sql.slice(dollar + 5, end);
}

const sql = await readFile(new URL(`../${HOTFIX}`, import.meta.url), 'utf8');
const body = functionBody(sql);

test('hotfix so substitui a funcao e nao altera dados', () => {
  assert.match(sql, /create or replace function public\.apply_store_order_gateway_status\(/);
  assert.match(sql, /p_external_reference text default null/);
  assert.equal(sql.trimStart().startsWith('-- Hotfix'), true);
  assert.doesNotMatch(sql, /\bdelete from\b/i);
  assert.doesNotMatch(sql, /\binsert into public\.(store_orders|payments|tickets)\b/);
  assert.doesNotMatch(sql, /alter table/i);
});

test('corpo SQL qualifica store_order_id e demais colunas que colidem com RETURNS TABLE', () => {
  const returns = sql.slice(
    sql.indexOf('returns table'),
    sql.indexOf('language plpgsql'),
  );
  assert.match(returns, /store_order_id uuid/);
  assert.match(returns, /organization_id uuid/);
  assert.match(returns, /previous_status text/);
  assert.match(returns, /applied_status text/);

  assert.doesNotMatch(body, /(?<![a-z.])store_order_id\b/);
  assert.match(body, /soi\.store_order_id = v_order\.id/);
  assert.match(body, /so\.gateway_payment_id = p_provider_payment_id/);
  assert.match(body, /so\.order_number = v_ext/);
  assert.match(body, /soi\.status = 'reserved'/);
  assert.match(body, /pu\.status = 'reserved'/);
  assert.match(body, /so\.payment_status/);
  assert.doesNotMatch(body, /(?<![a-z.])organization_id\b/);
  assert.doesNotMatch(body, /\bprevious_status\b/);
  assert.doesNotMatch(body, /\bapplied_status\b/);
});

test('ramo paid confirma item sem liberar reserva, sem ticket e com guarda de idempotencia', () => {
  const paidStart = body.indexOf("if p_internal_status = 'paid' then");
  const paidEnd = body.indexOf("store_order_gateway_status_ignored", paidStart);
  const paid = body.slice(paidStart, paidEnd);

  assert.match(paid, /update public\.store_order_items soi set status = 'confirmed'/);
  assert.match(paid, /store_order_payment_confirmed/);
  assert.match(paid, /if v_order\.status = 'confirmed' or v_order\.payment_status = 'paid' then/);
  assert.doesNotMatch(paid, /release_store_item_reservation/);
  assert.doesNotMatch(paid, /issue_ticket|insert into public\.tickets|confirm_order_payment_and_issue_tickets/);
  assert.doesNotMatch(paid, /insert into public\.payments/);
  assert.match(body, /return query select v_order\.id, v_order\.organization_id, v_previous, 'paid'/);
});

test('replay paid ja confirmado retorna cedo sem nova auditoria de confirmacao', () => {
  const paidStart = body.indexOf("if p_internal_status = 'paid' then");
  const firstGuardEnd = body.indexOf('end if;', paidStart);
  const guard = body.slice(paidStart, firstGuardEnd);
  assert.match(guard, /if v_order\.status = 'confirmed' or v_order\.payment_status = 'paid' then/);
  assert.match(guard, /return query select v_order\.id, v_order\.organization_id, v_previous, 'paid'/);
  assert.doesNotMatch(guard, /store_order_payment_confirmed/);
  assert.doesNotMatch(guard, /release_store_item_reservation/);
});

async function localAvailable() {
  try {
    const response = await fetch(`${LOCAL_URL}/rest/v1/`, {
      headers: { apikey: LOCAL_SERVICE_KEY },
      signal: AbortSignal.timeout(1500),
    });
    return response.ok || response.status === 200 || response.status === 401 || response.status === 404;
  } catch {
    return false;
  }
}

const canRunLocal = await localAvailable();

test('runtime: pending+reserved+PAYMENT_RECEIVED confirma sem ticket/cobranca e replay e idempotente', { skip: !canRunLocal }, async () => {
  const service = createClient(LOCAL_URL, LOCAL_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  async function must(promise, label) {
    const { data, error } = await promise;
    if (error) throw new Error(`${label}: ${error.message}`);
    return data;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const gatewayId = `pay_store_paid_${suffix}`;
  const org = await must(service.from('organizations').insert({ name: `Store paid ${suffix}`, slug: `store-paid-${suffix}` }).select('id').single(), 'org');
  const user = await must(service.auth.admin.createUser({
    email: `store-paid-${suffix}@qa.local`,
    password: 'SenhaForte!123',
    email_confirm: true,
  }), 'user');
  const item = await must(service.from('store_items').insert({
    organization_id: org.id,
    name: `Copo teste ${suffix}`,
    slug: `copo-teste-${suffix}`,
    price: 60,
    supply_mode: 'stock',
    visibility: 'public',
    is_active: true,
    requires_variant: false,
  }).select('id').single(), 'item');
  const inventory = await must(service.from('store_item_inventory').insert({
    organization_id: org.id,
    store_item_id: item.id,
    variant_id: null,
    total_quantity: 15,
    reserved_quantity: 1,
    delivered_quantity: 0,
  }).select('id,total_quantity,reserved_quantity,delivered_quantity').single(), 'inventory');
  const order = await must(service.from('store_orders').insert({
    organization_id: org.id,
    user_id: user.user.id,
    order_number: `LOJA-${suffix}`,
    status: 'pending',
    payment_status: 'pending',
    payment_method: 'pix',
    provider: 'asaas',
    gateway_payment_id: gatewayId,
    gateway_account_key: 'asaas-conta-live-01',
    base_amount: 60,
    final_amount: 60,
  }).select('id').single(), 'order');
  const line = await must(service.from('store_order_items').insert({
    store_order_id: order.id,
    store_item_id: item.id,
    variant_id: null,
    quantity: 1,
    unit_price: 60,
    final_amount: 60,
    status: 'reserved',
  }).select('id,status').single(), 'line');

  const first = await must(service.rpc('apply_store_order_gateway_status', {
    p_provider: 'asaas',
    p_provider_payment_id: gatewayId,
    p_provider_status: 'RECEIVED',
    p_internal_status: 'paid',
    p_gateway_amount: 60,
    p_expected_gateway_account_key: 'asaas-conta-live-01',
    p_event_type: 'PAYMENT_RECEIVED',
    p_external_reference: order.id,
  }), 'apply-first');
  const firstRow = Array.isArray(first) ? first[0] : first;
  assert.equal(firstRow.applied_status, 'paid');

  const after = await must(service.from('store_orders').select('status,payment_status,gateway_payment_id').eq('id', order.id).single(), 'order-after');
  assert.equal(after.status, 'confirmed');
  assert.equal(after.payment_status, 'paid');
  assert.equal(after.gateway_payment_id, gatewayId);

  const itemAfter = await must(service.from('store_order_items').select('status').eq('id', line.id).single(), 'item-after');
  assert.equal(itemAfter.status, 'confirmed');

  const invAfter = await must(
    service.from('store_item_inventory').select('total_quantity,reserved_quantity,delivered_quantity').eq('id', inventory.id).single(),
    'inv-after',
  );
  assert.equal(invAfter.total_quantity, 15);
  assert.equal(invAfter.reserved_quantity, 1);
  assert.equal(invAfter.delivered_quantity, 0);

  const tickets = await must(service.from('tickets').select('id').eq('order_id', order.id), 'tickets');
  assert.equal((tickets ?? []).length, 0);
  const payments = await must(service.from('payments').select('id').eq('gateway_payment_id', gatewayId), 'payments');
  assert.equal((payments ?? []).length, 0);

  const audits = await must(
    service.from('audit_logs').select('id,action').eq('entity_id', order.id).eq('action', 'store_order_payment_confirmed'),
    'audits',
  );
  assert.equal((audits ?? []).length, 1);

  const replay = await must(service.rpc('apply_store_order_gateway_status', {
    p_provider: 'asaas',
    p_provider_payment_id: gatewayId,
    p_provider_status: 'RECEIVED',
    p_internal_status: 'paid',
    p_gateway_amount: 60,
    p_expected_gateway_account_key: 'asaas-conta-live-01',
    p_event_type: 'PAYMENT_RECEIVED',
    p_external_reference: order.id,
  }), 'apply-replay');
  const replayRow = Array.isArray(replay) ? replay[0] : replay;
  assert.equal(replayRow.applied_status, 'paid');

  const afterReplay = await must(service.from('store_orders').select('status,payment_status').eq('id', order.id).single(), 'order-replay');
  assert.equal(afterReplay.status, 'confirmed');
  assert.equal(afterReplay.payment_status, 'paid');
  const itemReplay = await must(service.from('store_order_items').select('status').eq('id', line.id).single(), 'item-replay');
  assert.equal(itemReplay.status, 'confirmed');
  const invReplay = await must(
    service.from('store_item_inventory').select('total_quantity,reserved_quantity,delivered_quantity').eq('id', inventory.id).single(),
    'inv-replay',
  );
  assert.deepEqual(invReplay, { total_quantity: 15, reserved_quantity: 1, delivered_quantity: 0 });
  const auditsReplay = await must(
    service.from('audit_logs').select('id').eq('entity_id', order.id).eq('action', 'store_order_payment_confirmed'),
    'audits-replay',
  );
  assert.equal((auditsReplay ?? []).length, 1);
  const ticketsReplay = await must(service.from('tickets').select('id').eq('order_id', order.id), 'tickets-replay');
  assert.equal((ticketsReplay ?? []).length, 0);
  const paymentsReplay = await must(service.from('payments').select('id').eq('gateway_payment_id', gatewayId), 'payments-replay');
  assert.equal((paymentsReplay ?? []).length, 0);
});

if (!canRunLocal) {
  console.log('SKIP runtime apply_store_order_gateway_status: Supabase local indisponivel em 127.0.0.1:54321. Contrato SQL coberto acima.');
}
