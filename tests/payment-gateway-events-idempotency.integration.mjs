// Fase 1 Asaas -- P0: idempotencia de payment_gateway_events e da
// constraint UNIQUE(provider, gateway_payment_id) em payments. Roda contra o
// Supabase local (`supabase start`), no mesmo padrao dos demais
// *.integration.mjs deste projeto -- nao sobe servidor Next.js, exercita as
// RPCs SQL diretamente via @supabase/supabase-js.
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
  const org = await must(service.from('organizations').insert({ name: 'Gateway Events Test', slug: `gw-events-${suffix}` }).select('id').single(), 'org');
  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Gateway Events', year: 2026, slug: `gw-events-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const payment = await must(service.from('payments').insert({
    organization_id: org.id, event_id: event.id, amount: 100, final_amount: 100, payment_status: 'pending',
    payment_method: 'pix', provider: 'asaas', gateway_payment_id: `pay_evt_${suffix}`,
  }).select('id, gateway_payment_id').single(), 'payment');

  return { service, must, suffix, org, event, payment };
}

const fx = await buildFixture();

test('evento novo: is_new=true na primeira vez, gera 1 linha', async () => {
  const externalEventId = `evt-${fx.suffix}-novo`;
  const result = await fx.service.rpc('record_payment_gateway_event', {
    p_provider: 'asaas', p_external_event_id: externalEventId, p_event_type: 'PAYMENT_CONFIRMED',
    p_provider_payment_id: fx.payment.gateway_payment_id, p_payload: { id: externalEventId, event: 'PAYMENT_CONFIRMED' },
  });
  assert.equal(result.error, null, result.error?.message);
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  assert.equal(row.is_new, true);

  const { data: rows } = await fx.service.from('payment_gateway_events').select('id').eq('provider', 'asaas').eq('external_event_id', externalEventId);
  assert.equal(rows.length, 1);
});

test('mesmo webhook 2x: segunda chamada retorna is_new=false com o mesmo id, sem duplicar linha', async () => {
  const externalEventId = `evt-${fx.suffix}-2x`;
  const first = await fx.service.rpc('record_payment_gateway_event', {
    p_provider: 'asaas', p_external_event_id: externalEventId, p_event_type: 'PAYMENT_CONFIRMED',
    p_provider_payment_id: fx.payment.gateway_payment_id, p_payload: { id: externalEventId },
  });
  const second = await fx.service.rpc('record_payment_gateway_event', {
    p_provider: 'asaas', p_external_event_id: externalEventId, p_event_type: 'PAYMENT_CONFIRMED',
    p_provider_payment_id: fx.payment.gateway_payment_id, p_payload: { id: externalEventId },
  });
  const firstRow = Array.isArray(first.data) ? first.data[0] : first.data;
  const secondRow = Array.isArray(second.data) ? second.data[0] : second.data;
  assert.equal(firstRow.is_new, true);
  assert.equal(secondRow.is_new, false);
  assert.equal(secondRow.id, firstRow.id);

  const { data: rows } = await fx.service.from('payment_gateway_events').select('id').eq('provider', 'asaas').eq('external_event_id', externalEventId);
  assert.equal(rows.length, 1, 'mesmo evento entregue 2x deve gerar apenas 1 linha');
});

test('mesmo webhook 10x em paralelo: exatamente 1 linha, exatamente 1 is_new=true', async () => {
  const externalEventId = `evt-${fx.suffix}-10x`;
  const calls = Array.from({ length: 10 }, () => fx.service.rpc('record_payment_gateway_event', {
    p_provider: 'asaas', p_external_event_id: externalEventId, p_event_type: 'PAYMENT_CONFIRMED',
    p_provider_payment_id: fx.payment.gateway_payment_id, p_payload: { id: externalEventId },
  }));
  const results = await Promise.all(calls);
  for (const r of results) assert.equal(r.error, null, r.error?.message);
  const rows = results.map((r) => (Array.isArray(r.data) ? r.data[0] : r.data));
  const newOnes = rows.filter((r) => r.is_new === true);
  assert.equal(newOnes.length, 1, '10 entregas concorrentes do mesmo evento devem produzir exatamente 1 processamento logico');

  const { data: dbRows } = await fx.service.from('payment_gateway_events').select('id').eq('provider', 'asaas').eq('external_event_id', externalEventId);
  assert.equal(dbRows.length, 1);
});

test('dois requests concorrentes: apenas um consegue reivindicar o mesmo evento para processar', async () => {
  const externalEventId = `evt-${fx.suffix}-claim-race`;
  const recorded = await fx.must(fx.service.rpc('record_payment_gateway_event', {
    p_provider: 'asaas', p_external_event_id: externalEventId, p_event_type: 'PAYMENT_CONFIRMED',
    p_provider_payment_id: fx.payment.gateway_payment_id, p_payload: { id: externalEventId },
  }), 'record');
  const eventId = (Array.isArray(recorded) ? recorded[0] : recorded).id;

  const [claimA, claimB] = await Promise.all([
    fx.service.rpc('claim_payment_gateway_event_for_processing', { p_event_id: eventId }),
    fx.service.rpc('claim_payment_gateway_event_for_processing', { p_event_id: eventId }),
  ]);
  assert.equal(claimA.error, null, claimA.error?.message);
  assert.equal(claimB.error, null, claimB.error?.message);
  const claims = [claimA.data, claimB.data];
  assert.equal(claims.filter((c) => c === true).length, 1, 'so uma das duas chamadas concorrentes deve reivindicar o evento');

  // depois de "processado", uma nova tentativa de reivindicar deve falhar (idempotente).
  await fx.must(fx.service.rpc('mark_payment_gateway_event_processed', { p_event_id: eventId, p_status: 'processed' }), 'mark processed');
  const claimAfter = await fx.service.rpc('claim_payment_gateway_event_for_processing', { p_event_id: eventId });
  assert.equal(claimAfter.data, false, 'evento ja processado nao pode ser reivindicado de novo');
});

test('payment desconhecido: apply_gateway_payment_status falha com PAYMENT_NOT_FOUND para provider_payment_id inexistente', async () => {
  const result = await fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: `nao-existe-${fx.suffix}`, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  });
  assert.ok(result.error, 'deveria falhar para provider_payment_id desconhecido');
  assert.match(result.error.message, /PAYMENT_NOT_FOUND/);
});

test('provider_payment_id duplicado: UNIQUE(provider, gateway_payment_id) impede vincular a mesma cobranca a dois pagamentos', async () => {
  const duplicateId = `dup-${fx.suffix}`;
  const p1 = await fx.must(fx.service.from('payments').insert({
    organization_id: fx.org.id, event_id: fx.event.id, amount: 50, final_amount: 50, payment_status: 'pending',
    payment_method: 'pix', provider: 'asaas', gateway_payment_id: duplicateId,
  }).select('id').single(), 'payment 1');
  assert.ok(p1.id);

  const p2 = await fx.service.from('payments').insert({
    organization_id: fx.org.id, event_id: fx.event.id, amount: 60, final_amount: 60, payment_status: 'pending',
    payment_method: 'pix', provider: 'asaas', gateway_payment_id: duplicateId,
  }).select('id').single();
  assert.ok(p2.error, 'inserir a mesma (provider, gateway_payment_id) num segundo pagamento deve violar a constraint UNIQUE');
  assert.match(p2.error.message, /duplicate key|unique/i);
});

test('valor divergente: apply_gateway_payment_status nao confia em nenhum valor vindo do payload -- so em provider_payment_id/status', async () => {
  // Documentacao viva da garantia: a funcao nao recebe "amount" como
  // parametro de decisao nenhuma -- o valor cobrado e sempre o gravado em
  // payments.final_amount no momento da criacao do PIX (RPC start_order_payment_pix),
  // nunca o que vier solto no payload do webhook. Prova indireta: chamar com
  // um provider_payment_id valido funciona sem exigir nenhum "amount" de entrada.
  const localPayment = await fx.must(fx.service.from('payments').insert({
    organization_id: fx.org.id, event_id: fx.event.id, amount: 77, final_amount: 77, payment_status: 'pending',
    payment_method: 'pix', provider: 'asaas', gateway_payment_id: `amt-${fx.suffix}`,
  }).select('id').single(), 'payment valor');
  const result = await fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: `amt-${fx.suffix}`, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  });
  assert.equal(result.error, null, result.error?.message);
  const { data: after } = await fx.service.from('payments').select('final_amount').eq('id', localPayment.id).single();
  assert.equal(Number(after.final_amount), 77, 'final_amount permanece o valor local original, nunca sobrescrito pelo webhook');
});

test('organization divergente: apply_gateway_payment_status resolve o pagamento so por (provider, gateway_payment_id) -- nunca cruza organizacao por engano', async () => {
  const orgTwo = await fx.must(fx.service.from('organizations').insert({ name: 'Gateway Events Test B', slug: `gw-events-b-${fx.suffix}` }).select('id').single(), 'orgB');
  const eventTwo = await fx.must(fx.service.from('events').insert({
    organization_id: orgTwo.id, name: 'Evento Org B', year: 2026, slug: `gw-events-evt-b-${fx.suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'eventB');
  const sameExternalId = `shared-id-${fx.suffix}`;
  await fx.must(fx.service.from('payments').insert({
    organization_id: orgTwo.id, event_id: eventTwo.id, amount: 40, final_amount: 40, payment_status: 'pending',
    payment_method: 'pix', provider: 'asaas', gateway_payment_id: sameExternalId,
  }).select('id').single(), 'paymentB');

  const result = await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: sameExternalId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'apply status orgB');
  const row = Array.isArray(result) ? result[0] : result;
  assert.equal(row.organization_id, orgTwo.id, 'so a organizacao dona da cobranca e afetada');
});
