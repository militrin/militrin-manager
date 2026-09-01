// Fase 1 Asaas -- P0: apply_gateway_payment_status (pending nao emite, paid
// confirma, paid repetido nao duplica) e o guard de reativacao de ticket em
// confirm_order_item_and_issue_ticket (ticket cancelado/usado nao e alterado
// por reprocessamento tardio). Roda contra o Supabase local (`supabase start`).
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
  const org = await must(service.from('organizations').insert({ name: 'Gateway Status Test', slug: `gw-status-${suffix}` }).select('id').single(), 'org');

  const adminEmail = `gw-status-admin-${suffix}@qa.local`;
  const buyerEmail = `gw-status-buyer-${suffix}@qa.local`;
  const adminCreated = await must(service.auth.admin.createUser({ email: adminEmail, password, email_confirm: true }), 'create admin');
  const buyerCreated = await must(service.auth.admin.createUser({ email: buyerEmail, password, email_confirm: true }), 'create buyer');
  await must(service.from('organization_members').insert({ organization_id: org.id, user_id: adminCreated.user.id, is_owner: true, is_active: true }), 'admin member');

  const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
  await must(service.from('admin_users').insert({ user_id: adminCreated.user.id, role_id: ownerRole.id, is_active: true }), 'admin_users owner');
  await must(service.from('customer_profiles').upsert({ user_id: adminCreated.user.id, cpf: '52998224725', full_name: 'Admin', birth_date: '1985-01-01', phone: '11999990000', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'admin profile');
  await must(service.from('customer_profiles').upsert({ user_id: buyerCreated.user.id, cpf: '11144477735', full_name: 'Buyer', birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male' }, { onConflict: 'user_id' }), 'buyer profile');

  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Gateway Status', year: 2026, slug: `gw-status-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 150, female_price: 150, max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({ event_id: event.id, name: 'Geral', slug: `geral-${suffix}`, sort_order: 1, is_active: true }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 150, female_price: 150 }), 'price');

  const admin = await clientFor(adminEmail, password);
  const buyer = await clientFor(buyerEmail, password);

  async function createOrder(options = {}) {
    // CPF unico por pedido por padrao: HOLDER_ALREADY_HAS_TICKET_FOR_EVENT e
    // uma regra de negocio real (registration_contacts por organizacao+cpf, um
    // ticket ATIVO por titular por evento -- ver
    // 20260815006400_atomic_self_ticket_holder_uniqueness.sql). Varios testes
    // deste arquivo confirmam pagamento de verdade (ticket vira 'active');
    // reusar o mesmo CPF entre testes no mesmo evento colidiria com essa regra
    // -- cada createOrder() representa um comprador distinto por padrao.
    // `cpf`/`assignFirstToBuyer` sao overrides explicitos para os testes que
    // precisam deliberadamente do MESMO titular (bloqueio de 2o ticket) ou de
    // nenhum titular (ingresso sem titular).
    const cpf = options.cpf ?? generateValidCpf();
    const assignFirstToBuyer = options.assignFirstToBuyer ?? true;
    const r = await buyer.rpc('create_multi_ticket_order_checkout', {
      p_event_id: event.id, p_ticket_category_id: category.id, p_gender: 'male', p_quantity: 1,
      p_payment_method: 'pix', p_buyer_full_name: 'Buyer Test', p_buyer_cpf: cpf,
      p_buyer_birth_date: '1990-05-05', p_buyer_gender: 'male', p_buyer_phone: '11999990001',
      p_buyer_email: buyerEmail, p_buyer_city: 'Itapiranga', p_assign_first_to_buyer: assignFirstToBuyer,
      p_items: [{ ownership_mode: 'self' }], p_client_request_id: `gw-status-${Date.now()}-${Math.random()}`,
    });
    if (r.error) throw new Error(`create order: ${JSON.stringify(r.error)}`);
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    return row.order_id;
  }

  async function startAsaasPix(orderId) {
    const gatewayPaymentId = `pay_${orderId.slice(0, 8)}_${Date.now()}`;
    const r = await buyer.rpc('start_order_payment_pix', {
      p_order_id: orderId, p_pix_code: 'FAKE-PIX-CODE', p_pix_qrcode: 'data:image/svg+xml;utf8,fake',
      p_gateway_payment_id: gatewayPaymentId, p_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      p_provider: 'asaas',
    });
    if (r.error) throw new Error(`start pix: ${JSON.stringify(r.error)}`);
    return gatewayPaymentId;
  }

  async function orderItemFor(orderId) {
    return must(service.from('order_items').select('id').eq('order_id', orderId).single(), 'order item');
  }

  return { service, admin, buyer, org, event, must, createOrder, startAsaasPix, orderItemFor, suffix };
}

const fx = await buildFixture();

test('pending nao emite ticket', async () => {
  const orderId = await fx.createOrder();
  const gatewayPaymentId = await fx.startAsaasPix(orderId);
  const result = await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'PENDING', p_internal_status: 'pending',
  }), 'apply pending');
  const row = Array.isArray(result) ? result[0] : result;
  assert.equal(row.applied_status, 'pending');

  const { data: order } = await fx.service.from('orders').select('status').eq('id', orderId).single();
  assert.equal(order.status, 'pending');
  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', orderId);
  assert.equal(tickets.length, 0, 'nenhum ticket deve ser emitido para pagamento pendente');
});

test('paid confirma order/order_items e emite ticket', async () => {
  const orderId = await fx.createOrder();
  const gatewayPaymentId = await fx.startAsaasPix(orderId);
  const result = await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'apply paid');
  const row = Array.isArray(result) ? result[0] : result;
  assert.equal(row.applied_status, 'paid');

  const { data: order } = await fx.service.from('orders').select('status').eq('id', orderId).single();
  assert.equal(order.status, 'confirmed');
  const { data: tickets } = await fx.service.from('tickets').select('id,status').eq('order_id', orderId);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].status, 'active');
});

test('paid repetido (retry do mesmo webhook) nao duplica ticket nem muda paid_at', async () => {
  const orderId = await fx.createOrder();
  const gatewayPaymentId = await fx.startAsaasPix(orderId);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'apply paid 1');
  const { data: paymentAfterFirst } = await fx.service.from('payments').select('id,paid_at').eq('gateway_payment_id', gatewayPaymentId).single();

  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'RECEIVED', p_internal_status: 'paid',
  }), 'apply paid 2 (retry/segundo evento aprovado)');

  const { data: tickets } = await fx.service.from('tickets').select('id').eq('order_id', orderId);
  assert.equal(tickets.length, 1, 'retry de pagamento ja pago nao deve criar um segundo ticket');
  const { data: paymentAfterSecond } = await fx.service.from('payments').select('paid_at').eq('gateway_payment_id', gatewayPaymentId).single();
  assert.equal(paymentAfterSecond.paid_at, paymentAfterFirst.paid_at, 'paid_at original preservado no retry');
});

test('ticket cancelado por decisao administrativa NAO e reativado por reprocessamento tardio do pagamento', async () => {
  const orderId = await fx.createOrder();
  const gatewayPaymentId = await fx.startAsaasPix(orderId);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'apply paid');

  const { data: ticketBefore } = await fx.service.from('tickets').select('id,status').eq('order_id', orderId).single();
  assert.equal(ticketBefore.status, 'active');

  const cancelResult = await fx.must(fx.admin.rpc('owner_cancel_ticket', {
    p_ticket_id: ticketBefore.id, p_reason_code: 'other', p_reason_text: 'Teste Fase 1 Asaas: cancelamento administrativo',
    p_replacement_required: true,
  }), 'owner_cancel_ticket');
  assert.equal(cancelResult.status, 'cancelled');

  // Reprocessamento tardio: algo (webhook duplicado batendo em outro
  // caminho, reprocesso manual, etc.) chama de novo a confirmacao do
  // pagamento do pedido inteiro -- exatamente o cenario que a auditoria
  // apontou como capaz de reativar o ticket silenciosamente antes da
  // correcao desta fase.
  await fx.must(fx.service.rpc('confirm_order_payment_and_issue_tickets', { p_order_id: orderId }), 'reprocessa confirmacao');

  const { data: ticketAfter } = await fx.service.from('tickets').select('id,status,cancelled_at').eq('id', ticketBefore.id).single();
  assert.equal(ticketAfter.status, 'cancelled', 'ticket cancelado administrativamente nunca deve voltar a active por reprocessamento');
  assert.ok(ticketAfter.cancelled_at, 'cancelled_at deve permanecer preenchido');

  const { data: blockedLog } = await fx.service.from('audit_logs').select('id').eq('action', 'ticket_reactivation_blocked').eq('entity_id', ticketBefore.id);
  assert.ok(blockedLog.length >= 1, 'deve registrar auditoria do bloqueio de reativacao');
});

// Corrigido pela migration 20260900000000_fix_ticket_holder_uniqueness_upsert_self_conflict.sql.
// Causa raiz (confirmada por reproducao direta em psql, nao so pelo
// diagnostico deste teste): o trigger `enforce_ticket_holder_contact_uniqueness`
// em `tickets` (funcao trg_enforce_ticket_holder_contact_uniqueness) disparava
// com TG_OP='INSERT' mesmo quando confirm_order_item_and_issue_ticket cai no
// ramo ON CONFLICT DO UPDATE -- o Postgres roda o BEFORE INSERT antes de
// detectar o conflito, entao NEW.id ali era um uuid aleatorio (nunca o id real
// do ticket existente), quebrando a exclusao "ignore o proprio ticket" dentro
// de assert_ticket_holder_contact_available. A correcao detecta, na propria
// funcao do trigger, quando ja existe uma linha para o order_item_id (ou seja,
// o INSERT vai conflitar) e devolve NEW sem validar -- confiando na SEGUNDA
// chamada do mesmo trigger que o Postgres sempre dispara nesse caso, agora com
// TG_OP='UPDATE' e OLD/NEW corretos, onde a logica de "identidade inalterada"
// (ja existente desde 20260851000000) funciona como sempre deveria.
test('ticket ja usado (check-in feito) NAO e alterado por reprocessamento tardio', async () => {
  const orderId = await fx.createOrder();
  const gatewayPaymentId = await fx.startAsaasPix(orderId);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'apply paid');

  const { data: ticket } = await fx.service.from('tickets').select('id').eq('order_id', orderId).single();
  const usedAt = new Date().toISOString();
  await fx.must(fx.service.from('tickets').update({ status: 'used', used_at: usedAt }).eq('id', ticket.id).select('id').single(), 'marcar usado (simulado)');

  await fx.must(fx.service.rpc('confirm_order_payment_and_issue_tickets', { p_order_id: orderId }), 'reprocessa confirmacao');

  const { data: ticketAfter } = await fx.service.from('tickets').select('status,used_at').eq('id', ticket.id).single();
  assert.equal(ticketAfter.status, 'used', 'ticket usado nunca deve voltar a active por reprocessamento');
  assert.equal(new Date(ticketAfter.used_at).toISOString(), usedAt, 'used_at original preservado');
});

test('courtesy continua funcionando sem nenhum provider de gateway', async () => {
  const orderId = await fx.createOrder();
  const finalize = await fx.must(fx.buyer.rpc('finalize_cart_order_payment', { p_order_id: orderId, p_payment_method: 'courtesy' }), 'finalize courtesy');
  assert.equal(finalize.payment_status, 'paid');
  const { data: tickets } = await fx.service.from('tickets').select('status').eq('order_id', orderId);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].status, 'active');
  const { data: payment } = await fx.service.from('payments').select('provider').eq('order_id', orderId).single();
  assert.equal(payment.provider, null, 'cortesia nao deve ter nenhum provider de gateway associado');
});

// ── Regressao dedicada da correcao 20260900000000 (confirm_order_item_and_issue_ticket
// via INSERT...ON CONFLICT DO UPDATE) -- cobre exatamente a lista de cenarios
// pedida para fechar esta frente em 0 skip e 0 fail. ──────────────────────────

test('ticket active nao falha ao reconfirmar (segunda confirmacao direta retorna o mesmo ticket)', async () => {
  const orderId = await fx.createOrder();
  const gatewayPaymentId = await fx.startAsaasPix(orderId);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'apply paid');

  const { data: ticketBefore } = await fx.service.from('tickets').select('id,status').eq('order_id', orderId).single();
  assert.equal(ticketBefore.status, 'active');

  // Chama a confirmacao de novo diretamente (bypassa o curto-circuito de
  // apply_gateway_payment_status para paid->paid) -- exatamente o caminho que
  // um webhook duplicado real acabaria disparando via reconciliacao manual.
  await fx.must(fx.service.rpc('confirm_order_payment_and_issue_tickets', { p_order_id: orderId }), 'reconfirma diretamente (webhook duplicado simulado)');

  const { data: ticketsAfter } = await fx.service.from('tickets').select('id,status').eq('order_id', orderId);
  assert.equal(ticketsAfter.length, 1, 'nao pode duplicar ticket');
  assert.equal(ticketsAfter[0].id, ticketBefore.id, 'deve ser o MESMO ticket, nao um novo');
  assert.equal(ticketsAfter[0].status, 'active');
});

test('10 reconfirmacoes sequenciais do mesmo order_item continuam com exatamente 1 ticket', async () => {
  const orderId = await fx.createOrder();
  const gatewayPaymentId = await fx.startAsaasPix(orderId);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'apply paid');
  const { data: ticketBefore } = await fx.service.from('tickets').select('id').eq('order_id', orderId).single();

  for (let i = 0; i < 10; i += 1) {
    await fx.must(fx.service.rpc('confirm_order_payment_and_issue_tickets', { p_order_id: orderId }), `reconfirma #${i + 1}`);
  }

  const { data: ticketsAfter } = await fx.service.from('tickets').select('id').eq('order_id', orderId);
  assert.equal(ticketsAfter.length, 1);
  assert.equal(ticketsAfter[0].id, ticketBefore.id);
  const { data: itemsAfter } = await fx.service.from('order_items').select('id').eq('order_id', orderId);
  assert.equal(itemsAfter.length, 1, 'materializacao/order_items tambem nao duplica em retry repetido');
});

test('duas reconfirmacoes concorrentes do mesmo order_item continuam com exatamente 1 ticket', async () => {
  const orderId = await fx.createOrder();
  const gatewayPaymentId = await fx.startAsaasPix(orderId);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'apply paid');
  const { data: ticketBefore } = await fx.service.from('tickets').select('id').eq('order_id', orderId).single();

  const [r1, r2] = await Promise.all([
    fx.service.rpc('confirm_order_payment_and_issue_tickets', { p_order_id: orderId }),
    fx.service.rpc('confirm_order_payment_and_issue_tickets', { p_order_id: orderId }),
  ]);
  assert.equal(r1.error, null, r1.error?.message);
  assert.equal(r2.error, null, r2.error?.message);

  const { data: ticketsAfter } = await fx.service.from('tickets').select('id').eq('order_id', orderId);
  assert.equal(ticketsAfter.length, 1);
  assert.equal(ticketsAfter[0].id, ticketBefore.id);
});

test('segundo ticket diferente para a MESMA pessoa no mesmo evento continua bloqueado (regra nao foi enfraquecida)', async () => {
  const cpf = generateValidCpf();
  const firstOrderId = await fx.createOrder({ cpf });
  const firstGatewayPaymentId = await fx.startAsaasPix(firstOrderId);
  await fx.must(fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: firstGatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  }), 'apply paid (primeiro pedido)');

  // materialize_self_checkout_holder ja bloqueia na propria criacao do
  // segundo pedido (antes mesmo de chegar a pagamento) -- a regra "1 titular
  // por pessoa por evento" e aplicada em mais de um ponto do fluxo, e a
  // correcao desta migration nao afeta nenhum deles: so corrige QUANDO o
  // trigger de tickets reavalia um upsert que e o PROPRIO ticket, nunca a
  // deteccao de um titular genuinamente diferente pedido.
  await assert.rejects(
    () => fx.createOrder({ cpf }),
    (error) => {
      assert.match(error.message, /HOLDER_ALREADY_HAS_TICKET_FOR_EVENT/);
      return true;
    },
    'segundo pedido para a mesma pessoa no mesmo evento deve continuar sendo bloqueado'
  );
});

test('titulares diferentes no mesmo evento continuam permitidos (sem falso positivo)', async () => {
  const orderA = await fx.createOrder();
  const orderB = await fx.createOrder();
  const gatewayA = await fx.startAsaasPix(orderA);
  const gatewayB = await fx.startAsaasPix(orderB);

  const resultA = await fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayA, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  });
  const resultB = await fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayB, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  });
  assert.equal(resultA.error, null, resultA.error?.message);
  assert.equal(resultB.error, null, resultB.error?.message);

  const { data: ticketsA } = await fx.service.from('tickets').select('status').eq('order_id', orderA);
  const { data: ticketsB } = await fx.service.from('tickets').select('status').eq('order_id', orderB);
  assert.equal(ticketsA[0].status, 'active');
  assert.equal(ticketsB[0].status, 'active');
});

test('ingresso sem titular (sem registration_contact) continua valido e reconfirmavel', async () => {
  const orderId = await fx.createOrder({ assignFirstToBuyer: false });
  const gatewayPaymentId = await fx.startAsaasPix(orderId);

  const result = await fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  });
  assert.equal(result.error, null, result.error?.message);

  const { data: ticket } = await fx.service.from('tickets').select('id,status').eq('order_id', orderId).single();
  assert.equal(ticket.status, 'active');

  // Reconfirmar de novo (sem titular, assert_ticket_holder_contact_available
  // retorna cedo quando p_registration_contact_id e null) tambem precisa ser
  // idempotente.
  await fx.must(fx.service.rpc('confirm_order_payment_and_issue_tickets', { p_order_id: orderId }), 'reconfirma ingresso sem titular');
  const { data: ticketsAfter } = await fx.service.from('tickets').select('id').eq('order_id', orderId);
  assert.equal(ticketsAfter.length, 1);
  assert.equal(ticketsAfter[0].id, ticket.id);
});

test('webhook duplicado de pagamento paid passa sem erro e sem duplicar ticket (fim a fim via apply_gateway_payment_status)', async () => {
  const orderId = await fx.createOrder();
  const gatewayPaymentId = await fx.startAsaasPix(orderId);

  const first = await fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'CONFIRMED', p_internal_status: 'paid',
  });
  assert.equal(first.error, null, first.error?.message);

  // Webhook duplicado real: Asaas reenvia o MESMO evento (ou um segundo
  // evento de pagamento aprovado) para a MESMA cobranca.
  const duplicate = await fx.service.rpc('apply_gateway_payment_status', {
    p_provider: 'asaas', p_provider_payment_id: gatewayPaymentId, p_provider_status: 'RECEIVED', p_internal_status: 'paid',
  });
  assert.equal(duplicate.error, null, duplicate.error?.message);

  // E, alem do curto-circuito de apply_gateway_payment_status, o pior caso --
  // alguem reprocessando a confirmacao inteira de novo por fora -- tambem
  // precisa ser inofensivo.
  await fx.must(fx.service.rpc('confirm_order_payment_and_issue_tickets', { p_order_id: orderId }), 'reprocesso adicional por fora do webhook');

  const { data: tickets } = await fx.service.from('tickets').select('id,status').eq('order_id', orderId);
  assert.equal(tickets.length, 1, 'webhook duplicado nunca duplica ticket');
  assert.equal(tickets[0].status, 'active');
});
