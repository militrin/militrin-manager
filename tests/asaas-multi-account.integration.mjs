import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

async function environment() {
  const text = await readFile(new URL('../.env.local', import.meta.url), 'utf8').catch(() => '');
  const local = Object.fromEntries(text.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
  }));
  return {
    url: 'http://127.0.0.1:54321',
    serviceKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
    ...local,
  };
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
  const org = await must(service.from('organizations').insert({ name: 'Multi Account Test', slug: `multi-acc-${suffix}` }).select('id').single(), 'org');
  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Multi Conta', year: 2026, slug: `multi-acc-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  return { service, must, suffix, org, event };
}

const fx = await buildFixture();

test('webhook da conta PIX nao atualiza payment da conta CARD mesmo com o mesmo gateway_payment_id logico', async () => {
  const payId = `pay_shared_${fx.suffix}`;
  await fx.must(fx.service.from('payments').insert({
    organization_id: fx.org.id, event_id: fx.event.id, amount: 80, final_amount: 80,
    payment_status: 'pending', payment_method: 'credit_card', provider: 'asaas',
    gateway_payment_id: payId, gateway_account_key: 'conta-card',
  }).select('id').single(), 'card payment');

  const mismatch = await fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas',
    p_provider_payment_id: payId,
    p_provider_status: 'CONFIRMED',
    p_internal_status: 'paid',
    p_expected_gateway_account_key: 'conta-pix',
  });
  assert.equal(mismatch.error?.message, 'GATEWAY_ACCOUNT_MISMATCH');

  const { data: stillPending } = await fx.service.from('payments').select('payment_status').eq('gateway_payment_id', payId).single();
  assert.equal(stillPending.payment_status, 'pending');

  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas',
    p_provider_payment_id: payId,
    p_provider_status: 'CONFIRMED',
    p_internal_status: 'paid',
    p_expected_gateway_account_key: 'conta-card',
  }), 'card account can apply');
});

test('eventos de webhook com o mesmo id em contas diferentes nao colidem', async () => {
  const eventId = `evt_shared_${fx.suffix}`;
  const first = await fx.must(fx.service.rpc('record_payment_gateway_event', {
    p_provider: 'asaas', p_external_event_id: eventId, p_event_type: 'PAYMENT_CONFIRMED',
    p_provider_payment_id: 'pay_a', p_payload: { id: eventId }, p_gateway_account_key: 'conta-pix',
  }), 'pix event');
  const second = await fx.must(fx.service.rpc('record_payment_gateway_event', {
    p_provider: 'asaas', p_external_event_id: eventId, p_event_type: 'PAYMENT_CONFIRMED',
    p_provider_payment_id: 'pay_b', p_payload: { id: eventId }, p_gateway_account_key: 'conta-card',
  }), 'card event');
  const firstRow = Array.isArray(first) ? first[0] : first;
  const secondRow = Array.isArray(second) ? second[0] : second;
  assert.equal(firstRow.is_new, true);
  assert.equal(secondRow.is_new, true);
  assert.notEqual(firstRow.id, secondRow.id);

  const dup = await fx.must(fx.service.rpc('record_payment_gateway_event', {
    p_provider: 'asaas', p_external_event_id: eventId, p_event_type: 'PAYMENT_CONFIRMED',
    p_provider_payment_id: 'pay_a', p_payload: { id: eventId }, p_gateway_account_key: 'conta-pix',
  }), 'pix dup');
  const dupRow = Array.isArray(dup) ? dup[0] : dup;
  assert.equal(dupRow.is_new, false);
  assert.equal(dupRow.id, firstRow.id);
});
