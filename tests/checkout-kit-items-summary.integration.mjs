// Corrige "Sem itens de kit vinculados" aparecendo mesmo com camiseta
// configurada no resumo final do checkout publico. Causa raiz:
// mapOrderToRegistration (src/app/inscricao/[eventSlug]/wizard.tsx) tinha
// `kit_items: []` HARDCODED -- nunca lia participant_kit_items. A correcao
// faz getUnifiedOrderSnapshot (src/app/inscricao/actions.ts) consultar a
// MESMA tabela/join ja usados por src/app/minha-conta/ingressos/[ticketId]/itens/page.tsx
// (fonte canonica), filtrando por ticket_id -- a mesma coluna que a policy
// RLS participant_kit_items_ticket_owner_select usa para o comprador.
//
// Este arquivo testa a fonte de dados real (schema/RLS/trigger de
// materializacao) replicando a MESMA consulta que getUnifiedOrderKitItems
// executa -- getUnifiedOrderKitItems e uma funcao privada dentro de um
// modulo 'use server' e nao pode ser importada diretamente num teste Node;
// tests/checkout-kit-items-wiring.test.mjs cobre estaticamente que o codigo
// de producao usa exatamente esta consulta.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

function generateValidCpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  function checkDigit(nums) {
    let sum = 0, weight = nums.length + 1;
    for (const n of nums) { sum += n * weight; weight -= 1; }
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

// Exatamente a consulta feita por getUnifiedOrderKitItems em
// src/app/inscricao/actions.ts -- reproduzida aqui pra provar (contra o
// schema/RLS reais) que ela devolve o formato certo, sem duplicar linhas e
// respeitando a policy de dono do ticket.
async function fetchKitItemsAsBuyer(client, ticketIds) {
  const { data, error } = await client
    .from('participant_kit_items')
    .select('id, kit_item_id, ticket_id, variant_data, status, delivered_at, event_kit_items(name, item_type)')
    .in('ticket_id', ticketIds);
  if (error) throw new Error(`fetch kit items: ${JSON.stringify(error)}`);
  return (data ?? []).filter((row) => row.status !== 'cancelled');
}

async function buildFixture() {
  const env = await environment();
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

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const password = 'SenhaForte!123';
  const org = await must(service.from('organizations').insert({ name: 'Kit Summary Test', slug: `kit-summary-${suffix}` }).select('id').single(), 'org');

  await resolveOrCreateAdminRole(service, 'owner', 'Owner');

  const buyerEmail = `kit-summary-buyer-${suffix}@qa.local`;
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'create buyer');
  await must(service.from('customer_profiles').upsert({ user_id: buyerCreated.user.id, cpf: generateValidCpf(), full_name: 'Comprador Kit', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');
  const buyer = await clientFor(buyerEmail, password);

  // Evento COM kit configurado: 1 item de camiseta (com variante) + 1 item
  // de kit generico (sem variante, ex.: "Squeeze") -- cobre "camiseta +
  // outros itens de kit" no mesmo pedido, ja que o trigger de materializacao
  // cria uma linha por item de kit ATIVO do evento automaticamente.
  const eventWithKit = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Com Kit', year: 2026, slug: `kit-summary-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'eventWithKit');
  const batchWithKit = await must(service.from('registration_batches').insert({
    event_id: eventWithKit.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batchWithKit');
  const categoryWithKit = await must(service.from('ticket_categories').insert({ event_id: eventWithKit.id, name: 'Geral', slug: `geral-kit-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'categoryWithKit');
  await must(service.from('registration_batch_prices').insert({ batch_id: batchWithKit.id, ticket_category_id: categoryWithKit.id, male_price: 100, female_price: 100 }), 'priceWithKit');
  const shirtKitItem = await must(service.from('event_kit_items').insert({
    organization_id: org.id, event_id: eventWithKit.id, name: 'Camiseta', slug: `camiseta-${suffix}`,
    item_type: 'shirt', requires_variant: true, is_required: false, is_active: true, shirt_supply_mode: 'made_to_order',
  }).select('id').single(), 'shirtKitItem');
  const otherKitItem = await must(service.from('event_kit_items').insert({
    organization_id: org.id, event_id: eventWithKit.id, name: 'Squeeze', slug: `squeeze-${suffix}`,
    item_type: 'other', requires_variant: false, is_required: true, is_active: true,
  }).select('id').single(), 'otherKitItem');
  // create_multi_ticket_order_checkout exige uma linha de shirt_inventory
  // configurada para a variante escolhida, mesmo com limit_shirt_selection_to_stock
  // desligado (default) -- so nao BLOQUEIA por estoque insuficiente.
  await must(service.from('shirt_inventory').insert(['GG', 'M', 'P'].map((size) => ({
    event_id: eventWithKit.id, organization_id: org.id, shirt_type: 'Camiseta', shirt_size: size, total_quantity: 100,
  }))), 'shirt inventory');

  // Evento SEM nenhum kit configurado -- "nenhum item de kit real".
  const eventNoKit = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Sem Kit', year: 2026, slug: `no-kit-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'eventNoKit');
  const batchNoKit = await must(service.from('registration_batches').insert({
    event_id: eventNoKit.id, name: 'Lote', sequence_number: 1, male_price: 80, female_price: 80, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batchNoKit');
  const categoryNoKit = await must(service.from('ticket_categories').insert({ event_id: eventNoKit.id, name: 'Geral', slug: `geral-nokit-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'categoryNoKit');
  await must(service.from('registration_batch_prices').insert({ batch_id: batchNoKit.id, ticket_category_id: categoryNoKit.id, male_price: 80, female_price: 80 }), 'priceNoKit');

  async function createOrderWithShirt(eventId, categoryId, shirtType, shirtSize) {
    const r = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: eventId, p_ticket_category_id: categoryId, p_gender: 'male', p_quantity: 1,
      p_payment_method: 'pix', p_buyer_full_name: 'Comprador Kit', p_buyer_cpf: generateValidCpf(),
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: true,
      p_shirt_type: shirtType, p_shirt_size: shirtSize,
      p_items: [{ ownership_mode: 'self', shirt_type: shirtType, shirt_size: shirtSize }],
      p_client_request_id: `kit-summary-${Date.now()}-${Math.random()}`,
    });
    if (r.error) throw new Error(`create order: ${JSON.stringify(r.error)}`);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return row.order_id;
  }

  async function confirmOrderPaid(orderId) {
    const gatewayPaymentId = `fake_${orderId.slice(0, 8)}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await must(buyer.rpc('start_order_payment_pix', {
      p_order_id: orderId, p_pix_code: 'FAKE-PIX-CODE', p_pix_qrcode: 'data:image/svg+xml;utf8,fake',
      p_gateway_payment_id: gatewayPaymentId, p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      p_provider: 'fake',
    }), 'start pix');
    await must(buyer.rpc('simulate_fake_gateway_payment_paid', { p_order_id: orderId }), 'simulate paid');
  }

  return {
    service, buyer, org, suffix,
    eventWithKit, categoryWithKit, shirtKitItem, otherKitItem,
    eventNoKit, categoryNoKit,
    createOrderWithShirt, confirmOrderPaid, must,
    fetchKitItemsAsBuyer: (ticketIds) => fetchKitItemsAsBuyer(buyer, ticketIds),
  };
}

const fx = await buildFixture();

test('ingresso com camiseta: resumo materializa Camiseta com o tamanho escolhido, status reservado', async () => {
  const orderId = await fx.createOrderWithShirt(fx.eventWithKit.id, fx.categoryWithKit.id, 'Camiseta', 'GG');
  await fx.confirmOrderPaid(orderId);
  const ticket = await fx.must(fx.service.from('tickets').select('id').eq('order_id', orderId).single(), 'ticket');

  const kitItems = await fx.fetchKitItemsAsBuyer([ticket.id]);
  const shirtLink = kitItems.find((row) => row.kit_item_id === fx.shirtKitItem.id);
  assert.ok(shirtLink, 'deveria existir uma linha de participant_kit_items para a camiseta');
  assert.equal(shirtLink.event_kit_items.name, 'Camiseta');
  assert.equal(shirtLink.variant_data.shirt_size, 'GG');
  assert.equal(shirtLink.status, 'reserved', 'pagamento confirmado nao entrega o kit automaticamente -- reservar != entregar');
});

test('camiseta + outros itens de kit no mesmo pedido: lista todos', async () => {
  const orderId = await fx.createOrderWithShirt(fx.eventWithKit.id, fx.categoryWithKit.id, 'Camiseta', 'M');
  await fx.confirmOrderPaid(orderId);
  const ticket = await fx.must(fx.service.from('tickets').select('id').eq('order_id', orderId).single(), 'ticket');

  const kitItems = await fx.fetchKitItemsAsBuyer([ticket.id]);
  assert.equal(kitItems.length, 2, 'deve listar a camiseta E o item de kit generico (Squeeze)');
  const names = kitItems.map((row) => row.event_kit_items.name).sort();
  assert.deepEqual(names, ['Camiseta', 'Squeeze']);
});

test('item de kit entregue aparece com status delivered (vira "Entregue" na tela)', async () => {
  const orderId = await fx.createOrderWithShirt(fx.eventWithKit.id, fx.categoryWithKit.id, 'Camiseta', 'P');
  await fx.confirmOrderPaid(orderId);
  const ticket = await fx.must(fx.service.from('tickets').select('id').eq('order_id', orderId).single(), 'ticket');

  await fx.must(fx.service.from('participant_kit_items').update({ status: 'delivered', delivered_at: new Date().toISOString() })
    .eq('ticket_id', ticket.id).eq('kit_item_id', fx.shirtKitItem.id).select('id').single(), 'marcar entregue');

  const kitItems = await fx.fetchKitItemsAsBuyer([ticket.id]);
  const shirtLink = kitItems.find((row) => row.kit_item_id === fx.shirtKitItem.id);
  assert.equal(shirtLink.status, 'delivered');
});

test('refresh (nova consulta) apos emissao do ticket mantem o mesmo resultado', async () => {
  const orderId = await fx.createOrderWithShirt(fx.eventWithKit.id, fx.categoryWithKit.id, 'Camiseta', 'GG');
  await fx.confirmOrderPaid(orderId);
  const ticket = await fx.must(fx.service.from('tickets').select('id').eq('order_id', orderId).single(), 'ticket');

  const first = await fx.fetchKitItemsAsBuyer([ticket.id]);
  const second = await fx.fetchKitItemsAsBuyer([ticket.id]);
  assert.equal(first.length, second.length);
  assert.deepEqual(first.map((r) => r.id).sort(), second.map((r) => r.id).sort());
});

test('cortesia/admin (finalize_cart_order_payment courtesy) tambem materializa e mantem o kit', async () => {
  const orderId = await fx.createOrderWithShirt(fx.eventWithKit.id, fx.categoryWithKit.id, 'Camiseta', 'M');
  await fx.must(fx.buyer.rpc('finalize_cart_order_payment', { p_order_id: orderId, p_payment_method: 'courtesy' }), 'finalize courtesy');
  const ticket = await fx.must(fx.service.from('tickets').select('id').eq('order_id', orderId).single(), 'ticket');

  const kitItems = await fx.fetchKitItemsAsBuyer([ticket.id]);
  assert.ok(kitItems.some((row) => row.kit_item_id === fx.shirtKitItem.id), 'cortesia tambem deve mostrar a camiseta no resumo');
});

test('ingresso sem camiseta (tamanho/tipo nao informado) nao materializa o item de camiseta, mas materializa os demais itens de kit do evento', async () => {
  const orderId = await fx.createOrderWithShirt(fx.eventWithKit.id, fx.categoryWithKit.id, null, null);
  await fx.confirmOrderPaid(orderId);
  const ticket = await fx.must(fx.service.from('tickets').select('id').eq('order_id', orderId).single(), 'ticket');

  const kitItems = await fx.fetchKitItemsAsBuyer([ticket.id]);
  assert.ok(!kitItems.some((row) => row.kit_item_id === fx.shirtKitItem.id), 'sem tamanho/tipo escolhido, a camiseta nao deveria materializar');
  assert.ok(kitItems.some((row) => row.kit_item_id === fx.otherKitItem.id), 'item de kit sem variante continua materializando normalmente');
});

test('nenhum item de kit configurado no evento: lista vazia (tela deve mostrar "Nenhum item de kit incluido")', async () => {
  const orderId = await fx.createOrderWithShirt(fx.eventNoKit.id, fx.categoryNoKit.id, null, null);
  await fx.confirmOrderPaid(orderId);
  const ticket = await fx.must(fx.service.from('tickets').select('id').eq('order_id', orderId).single(), 'ticket');

  const kitItems = await fx.fetchKitItemsAsBuyer([ticket.id]);
  assert.equal(kitItems.length, 0);
});

test('nao duplica item de kit em reprocessamentos (constraint unica + upsert idempotente ja existentes continuam segurando isso)', async () => {
  const orderId = await fx.createOrderWithShirt(fx.eventWithKit.id, fx.categoryWithKit.id, 'Camiseta', 'GG');
  await fx.confirmOrderPaid(orderId);
  const ticket = await fx.must(fx.service.from('tickets').select('id').eq('order_id', orderId).single(), 'ticket');

  // Reconfirma o pagamento (idempotente, ja validado nos testes da fundacao
  // do gateway) -- nao deve duplicar nenhuma linha de kit.
  await fx.must(fx.service.rpc('confirm_order_payment_and_issue_tickets', { p_order_id: orderId }), 'reconfirma');

  const kitItems = await fx.fetchKitItemsAsBuyer([ticket.id]);
  const shirtLinks = kitItems.filter((row) => row.kit_item_id === fx.shirtKitItem.id);
  assert.equal(shirtLinks.length, 1, 'reprocessar a confirmacao nao pode duplicar a linha de kit');
});
