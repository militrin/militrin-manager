import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createClient } from '@supabase/supabase-js';

async function environment() {
  const text = await readFile(new URL('../.env.local', import.meta.url), 'utf8').catch(() => '');
  const local = Object.fromEntries(
    text.split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
      }),
  );
  return {
    url: 'http://127.0.0.1:54321',
    serviceKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
    ...local,
  };
}

const env = await environment();
const service = createClient(env.url, env.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function must(promise, label) {
  const result = await promise;
  if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
  return result.data;
}

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const PROVIDER_PAYMENT_ID = `pay_refund_closed_${suffix}`;

test('PAYMENT_CONFIRMED com financial_divergence deixa de ser aberta apos PAYMENT_REFUNDED processado', async () => {
  const confirmed = await must(
    service.rpc('record_payment_gateway_event', {
      p_provider: 'asaas',
      p_external_event_id: `evt_confirmed_${suffix}`,
      p_event_type: 'PAYMENT_CONFIRMED',
      p_provider_payment_id: PROVIDER_PAYMENT_ID,
      p_payload: {
        id: `evt_confirmed_${suffix}`,
        event: 'PAYMENT_CONFIRMED',
        payment: { id: PROVIDER_PAYMENT_ID, status: 'CONFIRMED', value: 55 },
      },
    }),
    'record_confirmed',
  );
  const confirmedId = (Array.isArray(confirmed) ? confirmed[0] : confirmed).id;
  await must(
    service.rpc('mark_payment_gateway_event_processed', {
      p_event_id: confirmedId,
      p_status: 'financial_divergence',
      p_error: `ORPHAN_CHARGE: pagamento ${PROVIDER_PAYMENT_ID}`,
    }),
    'mark_confirmed_divergence',
  );

  const refunded = await must(
    service.rpc('record_payment_gateway_event', {
      p_provider: 'asaas',
      p_external_event_id: `evt_refunded_${suffix}`,
      p_event_type: 'PAYMENT_REFUNDED',
      p_provider_payment_id: PROVIDER_PAYMENT_ID,
      p_payload: {
        id: `evt_refunded_${suffix}`,
        event: 'PAYMENT_REFUNDED',
        payment: { id: PROVIDER_PAYMENT_ID, status: 'REFUNDED', value: 55 },
      },
    }),
    'record_refunded',
  );
  const refundedId = (Array.isArray(refunded) ? refunded[0] : refunded).id;
  await must(
    service.rpc('mark_payment_gateway_event_processed', {
      p_event_id: refundedId,
      p_status: 'processed',
    }),
    'mark_refunded_processed',
  );

  const remaining = await service
    .from('payment_gateway_events')
    .select('id, event_type, processing_status')
    .eq('provider_payment_id', PROVIDER_PAYMENT_ID)
    .order('received_at');
  assert.equal(remaining.error, null, remaining.error?.message);
  assert.equal(remaining.data?.length, 2, 'historico dos dois eventos permanece');
  assert.equal(remaining.data.find((row) => row.event_type === 'PAYMENT_CONFIRMED')?.processing_status, 'financial_divergence');
  assert.equal(remaining.data.find((row) => row.event_type === 'PAYMENT_REFUNDED')?.processing_status, 'processed');

  const divergences = await must(service.rpc('list_gateway_financial_divergences'), 'list_open');
  const stillOpen = (divergences ?? []).find((row) => row.provider_payment_id === PROVIDER_PAYMENT_ID);
  assert.equal(stillOpen, undefined, 'refund processado posterior nao permanece como divergencia aberta');
});
