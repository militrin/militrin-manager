import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { summarizeIntegrityReport, mapReportRow } from '../src/lib/integrity/report.ts';

// Usado APENAS para construir, de proposito, o unico cenario de teste que
// exige contornar as duas triggers de protecao reais (enforce_ticket_holder_contact_uniqueness
// em tickets e a equivalente em order_items) -- exatamente para provar que o
// DETECTOR (a rede de seguranca) pega uma divergencia que essas triggers nao
// cobrem (ex.: uma correcao manual direta no banco). Nunca usado para
// nenhuma outra fixture -- todas as demais passam pelas RPCs reais.
function runSqlBypassingTriggers(sql) {
  execFileSync('docker', ['exec', '-i', 'supabase_db_militrin-manager', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql, encoding: 'utf8' });
}

const apiUrl = 'http://127.0.0.1:54321';
const localEnvironment = Object.fromEntries(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx.cmd supabase status -o env'], { encoding: 'utf8' })
  .split(/\r?\n/).flatMap((line) => { const match = line.match(/^([A-Z_]+)="?([^"\r\n]+)"?$/); return match ? [[match[1], match[2]]] : []; }));
const anonKey = localEnvironment.ANON_KEY;
const serviceKey = localEnvironment.SERVICE_ROLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(apiUrl, serviceKey, options);

// -------------------- helpers de fixture --------------------

let userCounter = 0;

async function createUser(fullName, cpf) {
  const suffix = `${Date.now()}-${userCounter++}`;
  const email = `integrity-${suffix}@example.test`;
  const password = 'Integrity-qa-123!';
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null, created.error?.message);
  const id = created.data.user.id;
  const profile = await service.from('customer_profiles').insert({
    user_id: id, cpf, full_name: fullName, birth_date: '1990-01-01', phone: '11999990000', city: 'Itapiranga', gender: 'male',
  });
  assert.equal(profile.error, null, profile.error?.message);
  return { id, email, password };
}

// Sessao real via login (mesmo padrao ja usado em
// self-ticket-holder-uniqueness.integration.mjs) -- e o unico jeito
// correto de simular auth.uid() para as RPCs security definer, ja que ele
// vem da sessao JWT, nunca de um header arbitrario.
async function clientFor(user) {
  const client = createClient(apiUrl, anonKey, options);
  const session = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  assert.equal(session.error, null, session.error?.message);
  return client;
}

async function ensureOwnerRole() {
  let role = await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle();
  if (!role.data) {
    role = await service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single();
  }
  return role.data.id;
}

async function makeOrgWithAdmin(label) {
  const suffix = `${Date.now()}-${userCounter++}`;
  const org = await service.from('organizations').insert({ name: `Integrity QA ${label}`, slug: `integrity-qa-${label}-${suffix}`, status: 'active' }).select('id').single();
  assert.equal(org.error, null, org.error?.message);
  const orgId = org.data.id;
  const admin = await createUser(`Admin ${label}`, '52998224725');
  const roleId = await ensureOwnerRole();
  const adminUser = await service.from('admin_users').insert({ user_id: admin.id, role_id: roleId, is_active: true });
  assert.equal(adminUser.error, null, adminUser.error?.message);
  const member = await service.from('organization_members').insert({ organization_id: orgId, user_id: admin.id, is_owner: true, is_active: true });
  assert.equal(member.error, null, member.error?.message);
  return { orgId, admin };
}

async function makeEvent(orgId, name, overrides = {}) {
  const suffix = `${Date.now()}-${userCounter++}`;
  const event = await service.from('events').insert({
    organization_id: orgId, name, year: 2031, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2031-10-10T12:00:00Z', min_age: 0, ...overrides,
  }).select('id').single();
  assert.equal(event.error, null, event.error?.message);
  return event.data.id;
}

async function makeFlatBatch(eventId, priceConfirmed) {
  const batch = await service.from('registration_batches').insert({
    event_id: eventId, name: 'Lote único', sequence_number: 1, male_price: 0, female_price: 0,
    max_confirmed_registrations: 500, is_active: true, flat_price_confirmed: priceConfirmed,
  }).select('id').single();
  assert.equal(batch.error, null, batch.error?.message);
  return batch.data.id;
}

// Um lote (registration_batches) e por EVENTO, nao por categoria (so pode
// existir 1 lote ATIVO por evento, ux_registration_batches_single_active) --
// categorias compartilham o mesmo lote via registration_batch_prices, um
// preco por (lote, categoria). p_sharedBatchId permite reusar o mesmo lote
// para varias categorias do mesmo evento.
async function makeCategoryWithBatch(eventId, name, sortOrder, sharedBatchId = null) {
  const suffix = `${Date.now()}-${userCounter++}`;
  const category = await service.from('ticket_categories').insert({ event_id: eventId, name, slug: `${name.toLowerCase()}-${suffix}`, is_active: true, sort_order: sortOrder }).select('id').single();
  assert.equal(category.error, null, category.error?.message);
  let batchId = sharedBatchId;
  if (!batchId) {
    const batch = await service.from('registration_batches').insert({
      event_id: eventId, name: `Lote ${name}`, sequence_number: sortOrder, male_price: 0, female_price: 0,
      max_confirmed_registrations: 500, is_active: true, flat_price_confirmed: true,
    }).select('id').single();
    assert.equal(batch.error, null, batch.error?.message);
    batchId = batch.data.id;
  }
  const price = await service.from('registration_batch_prices').insert({ batch_id: batchId, ticket_category_id: category.data.id, male_price: 0, female_price: 0, max_confirmed_registrations: 500 });
  assert.equal(price.error, null, price.error?.message);
  return { categoryId: category.data.id, batchId };
}

async function makeContact(orgId, fullName, cpf) {
  const contact = await service.from('registration_contacts').insert({ organization_id: orgId, full_name: fullName, cpf }).select('id').single();
  assert.equal(contact.error, null, contact.error?.message);
  return contact.data.id;
}

// Cria order+order_item+payment "pago" e (opcionalmente) o ticket real via
// confirm_order_item_and_issue_ticket -- o MESMO caminho de escrita usado
// pelo app, para nao inventar um estado que o sistema real nao produziria.
async function makePaidOrderItem(orgId, eventId, { categoryId = null, batchId = null, contactId = null, holderName = null, ownershipStatus = 'unassigned', issueTicket = true, shirtType = null, shirtSize = null } = {}) {
  const orderNumber = `INTQA-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const order = await service.from('orders').insert({
    organization_id: orgId, event_id: eventId, order_number: orderNumber, status: 'confirmed',
    base_amount: 0, final_amount: 0, buyer_type: 'administrative',
  }).select('id').single();
  assert.equal(order.error, null, order.error?.message);
  const orderId = order.data.id;

  const item = await service.from('order_items').insert({
    order_id: orderId, event_id: eventId, ticket_category_id: categoryId, batch_id: batchId,
    quantity: 1, unit_price: 0, final_amount: 0, status: 'confirmed',
    ownership_status: ownershipStatus, holder_full_name: holderName, registration_contact_id: contactId,
    shirt_type: shirtType, shirt_size: shirtSize,
  }).select('id').single();
  assert.equal(item.error, null, item.error?.message);
  const itemId = item.data.id;

  const payment = await service.from('payments').insert({
    organization_id: orgId, event_id: eventId, order_id: orderId, amount: 0, final_amount: 0,
    payment_method: 'courtesy', payment_status: 'paid', paid_at: new Date().toISOString(),
  }).select('id').single();
  assert.equal(payment.error, null, payment.error?.message);
  await service.from('orders').update({ payment_id: payment.data.id }).eq('id', orderId);

  let ticketId = null;
  if (issueTicket) {
    const rpc = await service.rpc('confirm_order_item_and_issue_ticket', { p_order_item_id: itemId });
    assert.equal(rpc.error, null, rpc.error?.message);
    ticketId = rpc.data;
  }
  return { orderId, itemId, ticketId, orderNumber };
}

async function callDetectorsAs(user, eventId) {
  const client = await clientFor(user);
  const result = await client.rpc('get_operational_integrity_report', { p_event_id: eventId });
  assert.equal(result.error, null, result.error?.message);
  return result.data;
}

// -------------------- fim helpers --------------------

test('evento saudável não produz nenhuma ocorrência falsa', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('healthy');
  const eventId = await makeEvent(orgId, 'Evento Saudavel');
  await makeFlatBatch(eventId, true);
  const contactId = await makeContact(orgId, 'Pessoa Saudavel', '52998224725');
  await makePaidOrderItem(orgId, eventId, { contactId, holderName: 'Pessoa Saudavel', ownershipStatus: 'assigned' });

  const rows = await callDetectorsAs(admin, eventId);
  assert.deepEqual(rows, [], `evento saudavel nao deveria ter nenhum problema, achou: ${JSON.stringify(rows)}`);
});

test('titularidade: duplicado detectado, nomeado-sem-titular detectado, sem-titular-legítimo NÃO detectado', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('holders');
  const eventId = await makeEvent(orgId, 'Evento Titularidade');
  await makeFlatBatch(eventId, true);
  const contactId = await makeContact(orgId, 'Titular Duplicado', '11144477735');

  // Duas triggers reais protegem esse estado em runtime (uma em tickets, uma
  // em order_items) -- corretamente, e nao devem ser enfraquecidas. Para
  // testar a REDE DE SEGURANCA (o detector), construimos os dois tickets
  // para contatos diferentes pelas RPCs reais e so then forcamos a colisao
  // via SQL direto com as triggers de sessao desativadas -- simulando
  // exatamente o tipo de divergencia que so uma correcao manual no banco
  // (fora do caminho normal do app) poderia produzir.
  const contactId2 = await makeContact(orgId, 'Titular Duplicado (2)', '39053344705');
  const first = await makePaidOrderItem(orgId, eventId, { contactId, holderName: 'Titular Duplicado', ownershipStatus: 'assigned' });
  const second = await makePaidOrderItem(orgId, eventId, { contactId: contactId2, holderName: 'Titular Duplicado (2)', ownershipStatus: 'assigned' });
  assert.ok(first.ticketId && second.ticketId);
  runSqlBypassingTriggers(`
    begin;
    set local session_replication_role = replica;
    update public.order_items set registration_contact_id = '${contactId}', holder_full_name = 'Titular Duplicado' where id = '${second.itemId}';
    commit;
  `);

  const namedItem = await makePaidOrderItem(orgId, eventId, { holderName: 'Fulano Sem CPF', ownershipStatus: 'unassigned', issueTicket: true });
  const issue = await service.from('participant_data_issues').insert({
    organization_id: orgId, event_id: eventId, order_item_id: namedItem.itemId,
    field_code: 'ticket_holder_identity', issue_type: 'insufficient_named_holder_identity',
    message: 'Titular informado sem dados suficientes para identificação',
    blocks_payment: false, blocks_ticket_issuance: false, blocks_checkin: false, blocks_kit_delivery: false,
    resolution_scope: 'admin_only', status: 'open',
  });
  assert.equal(issue.error, null, issue.error?.message);

  await makePaidOrderItem(orgId, eventId, { ownershipStatus: 'unassigned', issueTicket: true });

  const rows = await callDetectorsAs(admin, eventId);
  const duplicate = rows.filter((r) => r.code === 'DUPLICATE_ACTIVE_HOLDER');
  const named = rows.filter((r) => r.code === 'TICKET_NAMED_WITHOUT_CANONICAL_HOLDER');

  assert.equal(duplicate.length, 1, 'deve agrupar 1 problema DUPLICATE_ACTIVE_HOLDER para o evento');
  assert.equal(duplicate[0].affected_count, 2, 'os 2 ingressos do mesmo titular devem contar como afetados');
  assert.equal(named.length, 1);
  assert.equal(named[0].affected_count, 1);

  const titularidadeCodes = rows.filter((r) => r.domain === 'titularidade').map((r) => r.code);
  assert.deepEqual(new Set(titularidadeCodes), new Set(['DUPLICATE_ACTIVE_HOLDER', 'TICKET_NAMED_WITHOUT_CANONICAL_HOLDER']));
});

test('pedido pago sem ticket é detectado; ticket manual legítimo NÃO é órfão', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('order');
  const eventId = await makeEvent(orgId, 'Evento Pedido Pago');
  await makeFlatBatch(eventId, true);

  const brokenOrder = await makePaidOrderItem(orgId, eventId, { ownershipStatus: 'unassigned', issueTicket: false });
  const manualOrder = await makePaidOrderItem(orgId, eventId, { ownershipStatus: 'unassigned', issueTicket: true });

  const rows = await callDetectorsAs(admin, eventId);
  const missing = rows.filter((r) => r.code === 'PAID_ORDER_WITHOUT_TICKET');
  const orphan = rows.filter((r) => r.code === 'TICKET_WITHOUT_ORDER_ITEM');

  assert.equal(missing.length, 1);
  assert.equal(missing[0].affected_count, 1);
  assert.equal(orphan.length, 0, 'ticket manual legitimo nao pode aparecer como orfao');

  const client = await clientFor(admin);
  const detail = await client.rpc('get_operational_integrity_issue_entities', { p_code: 'PAID_ORDER_WITHOUT_TICKET', p_event_id: eventId });
  assert.equal(detail.error, null, detail.error?.message);
  assert.equal(detail.data.length, 1);
  assert.equal(detail.data[0].entity_id, brokenOrder.itemId);

  const manualTicket = await service.from('tickets').select('id,status').eq('order_item_id', manualOrder.itemId).maybeSingle();
  assert.equal(manualTicket.error, null);
  assert.equal(manualTicket.data.status, 'active');
});

test('ingresso único: preço não confirmado bloqueia; preço confirmado fica OK', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('price');

  const eventUnconfirmed = await makeEvent(orgId, 'Evento Preco Nao Confirmado');
  await makeFlatBatch(eventUnconfirmed, false);

  const eventConfirmed = await makeEvent(orgId, 'Evento Preco Confirmado');
  await makeFlatBatch(eventConfirmed, true);

  const rowsUnconfirmed = await callDetectorsAs(admin, eventUnconfirmed);
  assert.equal(rowsUnconfirmed.filter((r) => r.code === 'SINGLE_TICKET_PRICE_NOT_CONFIRMED').length, 1);

  const rowsConfirmed = await callDetectorsAs(admin, eventConfirmed);
  assert.equal(rowsConfirmed.filter((r) => r.code === 'SINGLE_TICKET_PRICE_NOT_CONFIRMED').length, 0);
});

test('evento com 1 categoria não acusa ausência de categoria; evento com 2 categorias válidas fica OK', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('cat');

  const eventOne = await makeEvent(orgId, 'Evento Uma Categoria');
  await makeCategoryWithBatch(eventOne, 'Geral', 1);

  const eventTwo = await makeEvent(orgId, 'Evento Duas Categorias');
  const { batchId: sharedBatchId } = await makeCategoryWithBatch(eventTwo, 'Elite', 1);
  await makeCategoryWithBatch(eventTwo, 'Open', 2, sharedBatchId);

  const rowsOne = await callDetectorsAs(admin, eventOne);
  const rowsTwo = await callDetectorsAs(admin, eventTwo);

  assert.equal(rowsOne.filter((r) => r.domain === 'categoria_preco').length, 0, '1 categoria valida nao deve gerar nenhum problema de categoria/preco');
  assert.equal(rowsTwo.filter((r) => r.domain === 'categoria_preco').length, 0, '2 categorias validas nao devem gerar nenhum problema de categoria/preco');
});

test('camiseta obrigatória sem variante é detectada; evento sem camiseta não gera falso positivo', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('shirt');

  const eventShirt = await makeEvent(orgId, 'Evento Camiseta');
  await makeFlatBatch(eventShirt, true);
  const kitItem = await service.from('event_kit_items').insert({
    organization_id: orgId, event_id: eventShirt, name: 'Camiseta', slug: `camiseta-${Date.now()}`,
    item_type: 'shirt', is_active: true, is_required: true, requires_variant: true, shirt_supply_mode: 'disabled',
  }).select('id').single();
  assert.equal(kitItem.error, null, kitItem.error?.message);
  const variant = await service.from('event_kit_item_variants').insert({ kit_item_id: kitItem.data.id, name: 'Tamanho', value: 'M', is_active: true });
  assert.equal(variant.error, null, variant.error?.message);

  // A emissao do ticket ja dispara trg_attach_unresolved_kit_items_to_ticket,
  // que cria automaticamente a linha em participant_kit_items (com
  // variant_data nulo) -- nao inserimos, so completamos a variante no caso
  // "com variante" e deixamos o caso "sem variante" exatamente como o
  // trigger criou.
  const withVariant = await makePaidOrderItem(orgId, eventShirt, { ownershipStatus: 'unassigned', shirtType: 'unissex', shirtSize: 'M' });
  const autoCreatedPki = await service.from('participant_kit_items').select('id').eq('order_item_id', withVariant.itemId).eq('kit_item_id', kitItem.data.id).maybeSingle();
  assert.equal(autoCreatedPki.error, null, autoCreatedPki.error?.message);
  assert.ok(autoCreatedPki.data, 'trigger deveria ter criado o participant_kit_items automaticamente ao emitir o ticket');
  const pkiOk = await service.from('participant_kit_items').update({
    status: 'confirmed', variant_data: { variant_id: crypto.randomUUID(), size: 'M' },
  }).eq('id', autoCreatedPki.data.id);
  assert.equal(pkiOk.error, null, pkiOk.error?.message);

  const withoutVariant = await makePaidOrderItem(orgId, eventShirt, { ownershipStatus: 'unassigned' });

  const eventNoShirt = await makeEvent(orgId, 'Evento Sem Camiseta');
  await makeFlatBatch(eventNoShirt, true);
  await makePaidOrderItem(orgId, eventNoShirt, { ownershipStatus: 'unassigned' });

  const rowsShirt = await callDetectorsAs(admin, eventShirt);
  const missingVariant = rowsShirt.filter((r) => r.code === 'TICKET_MISSING_REQUIRED_SHIRT_VARIANT');
  assert.equal(missingVariant.length, 1);
  assert.equal(missingVariant[0].affected_count, 1);

  const client = await clientFor(admin);
  const detail = await client.rpc('get_operational_integrity_issue_entities', { p_code: 'TICKET_MISSING_REQUIRED_SHIRT_VARIANT', p_event_id: eventShirt });
  assert.equal(detail.error, null, detail.error?.message);
  assert.equal(detail.data[0].entity_id, withoutVariant.ticketId);

  const rowsNoShirt = await callDetectorsAs(admin, eventNoShirt);
  assert.equal(rowsNoShirt.filter((r) => r.code === 'TICKET_MISSING_REQUIRED_SHIRT_VARIANT').length, 0, 'evento sem kit de camiseta nunca pode acusar variante ausente');
});

test('estoque: reserved_quantity > total sozinho NÃO gera problema; delivered > total gera', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('stock');
  const eventId = await makeEvent(orgId, 'Evento Estoque');
  await makeFlatBatch(eventId, true);

  const overReserved = await service.from('shirt_inventory').insert({
    organization_id: orgId, event_id: eventId, shirt_type: 'unissex', shirt_size: 'M',
    total_quantity: 1, reserved_quantity: 10, delivered_quantity: 0,
  });
  assert.equal(overReserved.error, null, overReserved.error?.message);

  const overDelivered = await service.from('shirt_inventory').insert({
    organization_id: orgId, event_id: eventId, shirt_type: 'unissex', shirt_size: 'G',
    total_quantity: 5, reserved_quantity: 0, delivered_quantity: 8,
  }).select('id').single();
  assert.equal(overDelivered.error, null, overDelivered.error?.message);

  const rows = await callDetectorsAs(admin, eventId);
  const stockIssues = rows.filter((r) => r.domain === 'estoque');
  assert.equal(stockIssues.length, 1, `so o delivered>total deveria aparecer: ${JSON.stringify(stockIssues)}`);
  assert.equal(stockIssues[0].code, 'SHIRT_INVENTORY_DELIVERED_EXCEEDS_TOTAL');
});

test('ticket cancelado com estado operacional impossível é detectado', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('cancel');
  const eventId = await makeEvent(orgId, 'Evento Cancelado Impossivel');
  await makeFlatBatch(eventId, true);

  const paid = await makePaidOrderItem(orgId, eventId, { ownershipStatus: 'unassigned' });
  // Nenhuma RPC ativa permite este estado (checkin_ticket_entry bloqueia
  // cancelado; admin_cancel_ticket/admin_update_payment_status bloqueiam
  // cancelar ticket com used_at) -- construimos via update direto (service
  // role) exatamente para provar que o DETECTOR pega uma regressao futura.
  const update = await service.from('tickets').update({ status: 'cancelled', cancelled_at: new Date().toISOString(), used_at: new Date().toISOString() }).eq('id', paid.ticketId);
  assert.equal(update.error, null, update.error?.message);

  const kitPaid = await makePaidOrderItem(orgId, eventId, { ownershipStatus: 'unassigned' });
  const kitItem = await service.from('event_kit_items').insert({
    organization_id: orgId, event_id: eventId, name: 'Kit', slug: `kit-${Date.now()}`, item_type: 'other', is_active: true,
  }).select('id').single();
  assert.equal(kitItem.error, null, kitItem.error?.message);
  const pki = await service.from('participant_kit_items').insert({
    organization_id: orgId, event_id: eventId, kit_item_id: kitItem.data.id, ticket_id: kitPaid.ticketId, status: 'reserved',
  });
  assert.equal(pki.error, null, pki.error?.message);
  const cancelKitTicket = await service.from('tickets').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', kitPaid.ticketId);
  assert.equal(cancelKitTicket.error, null, cancelKitTicket.error?.message);

  const rows = await callDetectorsAs(admin, eventId);
  assert.equal(rows.filter((r) => r.code === 'TICKET_CANCELLED_WITH_CHECKIN').length, 1);
  assert.equal(rows.filter((r) => r.code === 'TICKET_CANCELLED_WITH_PENDING_KIT_ITEM').length, 1);
});

test('filtro por evento funciona', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('filter');
  const eventA = await makeEvent(orgId, 'Evento Filtro A');
  await makeFlatBatch(eventA, false);
  const eventB = await makeEvent(orgId, 'Evento Filtro B');
  await makeFlatBatch(eventB, true);

  const allRows = await callDetectorsAs(admin, null);
  const onlyA = await callDetectorsAs(admin, eventA);
  const onlyB = await callDetectorsAs(admin, eventB);

  assert.ok(allRows.some((r) => r.event_id === eventA && r.code === 'SINGLE_TICKET_PRICE_NOT_CONFIRMED'));
  assert.ok(onlyA.every((r) => r.event_id === eventA));
  assert.equal(onlyA.filter((r) => r.code === 'SINGLE_TICKET_PRICE_NOT_CONFIRMED').length, 1);
  assert.equal(onlyB.length, 0);
});

test('organização A não enxerga problemas da organização B', async () => {
  const { orgId: orgAId, admin: adminA } = await makeOrgWithAdmin('isoA');
  const { orgId: orgBId, admin: adminB } = await makeOrgWithAdmin('isoB');

  const eventA = await makeEvent(orgAId, 'Evento Isolado A');
  await makeFlatBatch(eventA, false);
  const eventB = await makeEvent(orgBId, 'Evento Isolado B');
  await makeFlatBatch(eventB, false);

  const rowsA = await callDetectorsAs(adminA, null);
  const rowsB = await callDetectorsAs(adminB, null);

  assert.ok(rowsA.some((r) => r.event_id === eventA));
  assert.ok(rowsA.every((r) => r.event_id !== eventB), 'admin da organizacao A jamais pode ver o evento da organizacao B');
  assert.ok(rowsB.some((r) => r.event_id === eventB));
  assert.ok(rowsB.every((r) => r.event_id !== eventA));

  const clientA = await clientFor(adminA);
  const forbidden = await clientA.rpc('get_operational_integrity_report', { p_event_id: eventB });
  assert.notEqual(forbidden.error, null, 'admin de A pedindo o evento de B deve ser rejeitado');
});

test('usuário sem integrity.view não acessa a central; integrity.view sozinho não concede permissões de correção', async () => {
  const { orgId } = await makeOrgWithAdmin('perm');
  const noPermissionUser = await createUser('Sem Permissao', '39053344705');
  await service.from('organization_members').insert({ organization_id: orgId, user_id: noPermissionUser.id, is_owner: false, is_active: true });

  const clientNone = await clientFor(noPermissionUser);
  const denied = await clientNone.rpc('get_operational_integrity_report', { p_event_id: null });
  assert.notEqual(denied.error, null, 'usuario sem integrity.view deve ser rejeitado pela RPC');

  let integrityRole = await service.from('admin_roles').select('id').eq('code', 'guard_integrity_only').maybeSingle();
  if (!integrityRole.data) {
    integrityRole = await service.from('admin_roles').insert({ code: 'guard_integrity_only', name: 'Integrity Only', is_system: false, is_active: true }).select('id').single();
  }
  const integrityPermission = await service.from('admin_permissions').select('id').eq('code', 'integrity.view').single();
  assert.equal(integrityPermission.error, null, integrityPermission.error?.message);
  await service.from('admin_role_permissions').upsert({ role_id: integrityRole.data.id, permission_id: integrityPermission.data.id }, { onConflict: 'role_id,permission_id' });

  const integrityOnlyUser = await createUser('So Integridade', '16899535009');
  await service.from('admin_users').insert({ user_id: integrityOnlyUser.id, role_id: integrityRole.data.id, is_active: true });
  await service.from('organization_members').insert({ organization_id: orgId, user_id: integrityOnlyUser.id, is_owner: false, is_active: true });

  const clientIntegrityOnly = await clientFor(integrityOnlyUser);
  const allowed = await clientIntegrityOnly.rpc('get_operational_integrity_report', { p_event_id: null });
  assert.equal(allowed.error, null, allowed.error?.message);

  const cannotManageTickets = await clientIntegrityOnly.rpc('current_user_has_permission', { p_permission_code: 'tickets.manage' });
  assert.equal(cannotManageTickets.error, null, cannotManageTickets.error?.message);
  assert.equal(cannotManageTickets.data, false, 'integrity.view sozinho jamais concede permissoes de correcao de outras paginas');
});

test('ticket órfão (order_item_id nulo) é detectado', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('orphan');
  const eventId = await makeEvent(orgId, 'Evento Orfao');
  await makeFlatBatch(eventId, true);
  const paid = await makePaidOrderItem(orgId, eventId, { ownershipStatus: 'unassigned' });

  // Nenhuma RPC ativa jamais deixa order_item_id nulo -- simulamos a
  // regressao (ex.: exclusao do order_item) via update direto.
  const orphan = await service.from('tickets').update({ order_item_id: null }).eq('id', paid.ticketId);
  assert.equal(orphan.error, null, orphan.error?.message);

  const rows = await callDetectorsAs(admin, eventId);
  assert.equal(rows.filter((r) => r.code === 'TICKET_WITHOUT_ORDER_ITEM').length, 1);
});

test('pendência de cadastro aberta e bloqueante é detectada', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('data-issue');
  const eventId = await makeEvent(orgId, 'Evento Pendencia');
  await makeFlatBatch(eventId, true);
  const contactId = await makeContact(orgId, 'Pessoa Pendente', '93541134780');
  const paid = await makePaidOrderItem(orgId, eventId, { contactId, holderName: 'Pessoa Pendente', ownershipStatus: 'assigned' });

  const issue = await service.from('participant_data_issues').insert({
    organization_id: orgId, event_id: eventId, order_item_id: paid.itemId, ticket_id: paid.ticketId,
    registration_contact_id: contactId, field_code: 'cpf', issue_type: 'missing_required_identity',
    message: 'CPF pendente de confirmação', blocks_payment: true, blocks_ticket_issuance: false,
    blocks_checkin: false, blocks_kit_delivery: false, resolution_scope: 'admin_only', status: 'open',
  });
  assert.equal(issue.error, null, issue.error?.message);

  const rows = await callDetectorsAs(admin, eventId);
  const found = rows.filter((r) => r.code === 'OPEN_BLOCKING_DATA_ISSUE');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'critical', 'bloquear pagamento deve ser critico');
});

test('categoria/lote de outro evento é detectado; evento exige camiseta sem tamanhos configurados é detectado', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('mismatch');
  const eventA = await makeEvent(orgId, 'Evento Mismatch A');
  const { categoryId } = await makeCategoryWithBatch(eventA, 'Geral', 1);
  const eventB = await makeEvent(orgId, 'Evento Mismatch B');
  await makeFlatBatch(eventB, true);
  // order_item pertence ao evento B mas referencia a categoria do evento A.
  const mismatchItem = await makePaidOrderItem(orgId, eventB, { categoryId, ownershipStatus: 'unassigned' });
  assert.ok(mismatchItem.itemId);

  const rowsMismatch = await callDetectorsAs(admin, eventB);
  assert.equal(rowsMismatch.filter((r) => r.code === 'ORDER_ITEM_CATEGORY_EVENT_MISMATCH').length, 1);

  const eventShirt = await makeEvent(orgId, 'Evento Camiseta Sem Tamanho');
  await makeFlatBatch(eventShirt, true);
  const kitItem = await service.from('event_kit_items').insert({
    organization_id: orgId, event_id: eventShirt, name: 'Camiseta', slug: `camiseta-sem-tam-${Date.now()}`,
    item_type: 'shirt', is_active: true, is_required: true, requires_variant: true, shirt_supply_mode: 'disabled',
  });
  assert.equal(kitItem.error, null, kitItem.error?.message);
  // Nenhum event_kit_item_variants cadastrado -- configuracao incompleta.

  const rowsShirtConfig = await callDetectorsAs(admin, eventShirt);
  const withoutVariants = rowsShirtConfig.filter((r) => r.code === 'EVENT_SHIRT_KIT_WITHOUT_VARIANTS');
  assert.equal(withoutVariants.length, 1);
  assert.equal(withoutVariants[0].severity, 'critical', 'vendas abertas + camiseta obrigatoria sem tamanho deve ser critico');
});

test('Dashboard e Central retornam os mesmos totais (ambos consomem a mesma RPC + summarizeIntegrityReport)', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('samedash');
  const eventId = await makeEvent(orgId, 'Evento Mesmos Totais');
  await makeFlatBatch(eventId, false); // preco nao confirmado -> 1 problema critico
  await makePaidOrderItem(orgId, eventId, { holderName: 'Fulano Sem CPF', ownershipStatus: 'unassigned', issueTicket: true });

  const client = await clientFor(admin);
  // Simula exatamente o que o Dashboard (src/app/painel/page.tsx) e a Central
  // (src/app/painel/integridade/actions.ts) fazem cada um -- duas chamadas
  // independentes as MESMAS RPCs, sem nenhuma logica de agregacao propria.
  const [dashboardReport, dashboardCodes] = await Promise.all([
    client.rpc('get_operational_integrity_report', { p_event_id: eventId }),
    client.rpc('get_operational_integrity_detector_codes'),
  ]);
  const [centralReport, centralCodes] = await Promise.all([
    client.rpc('get_operational_integrity_report', { p_event_id: eventId }),
    client.rpc('get_operational_integrity_detector_codes'),
  ]);
  assert.equal(dashboardReport.error, null); assert.equal(centralReport.error, null);

  const dashboardTotals = summarizeIntegrityReport(dashboardReport.data.map(mapReportRow), dashboardCodes.data.length);
  const centralTotals = summarizeIntegrityReport(centralReport.data.map(mapReportRow), centralCodes.data.length);

  assert.deepEqual(dashboardTotals, centralTotals, 'Dashboard e Central devem exibir exatamente os mesmos totais para o mesmo evento');
  assert.ok(dashboardTotals.critical >= 1, 'sanity check: o fixture deveria produzir pelo menos 1 bloqueio');
});

test('estado saudável apresenta verificações aprovadas corretamente', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('okcount');
  const eventId = await makeEvent(orgId, 'Evento Totalmente Saudavel');
  await makeFlatBatch(eventId, true);

  const client = await clientFor(admin);
  const codesResult = await client.rpc('get_operational_integrity_detector_codes');
  assert.equal(codesResult.error, null, codesResult.error?.message);
  const totalDetectors = codesResult.data.length;
  assert.ok(totalDetectors >= 14, 'devem existir pelo menos os 14 detectores da V1');

  const rows = await callDetectorsAs(admin, eventId);
  assert.equal(rows.length, 0);
  const okCount = totalDetectors - new Set(rows.map((r) => r.code)).size;
  assert.equal(okCount, totalDetectors, 'evento saudavel deve aprovar todas as verificacoes');
});
