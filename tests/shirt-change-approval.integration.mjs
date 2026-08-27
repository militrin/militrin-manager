import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

// Fecha o ciclo de aprovacao administrativa das solicitacoes de alteracao de
// item de kit (P0) -- ver auditoria: o backend (ticket_item_change_requests,
// request_ticket_item_change, review_ticket_item_change_request,
// admin_change_ticket_shirt) ja existia inteiro e e SO o que este arquivo
// exercita; nenhuma tabela/RPC nova foi criada, entao estes testes chamam as
// MESMAS RPCs que o novo /operacoes/solicitacoes e o server action
// reviewTicketItemChangeAction (src/app/minha-conta/actions.ts) chamam.

const apiUrl = 'http://127.0.0.1:54321';
const localEnvironment = Object.fromEntries(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx.cmd supabase status -o env'], { encoding: 'utf8' })
  .split(/\r?\n/).flatMap((line) => { const match = line.match(/^([A-Z_]+)="?([^"\r\n]+)"?$/); return match ? [[match[1], match[2]]] : []; }));
const anonKey = localEnvironment.ANON_KEY;
const serviceKey = localEnvironment.SERVICE_ROLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(apiUrl, serviceKey, options);

// -------------------- helpers de fixture (mesmo padrao de tests/operational-integrity.integration.mjs) --------------------

let userCounter = 0;

async function createUser(fullName, cpf) {
  const suffix = `${Date.now()}-${userCounter++}`;
  const email = `shirt-approval-${suffix}@example.test`;
  const password = 'ShirtApproval-qa-123!';
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null, created.error?.message);
  const id = created.data.user.id;
  const profile = await service.from('customer_profiles').insert({
    user_id: id, cpf, full_name: fullName, birth_date: '1990-01-01', phone: '11999990000', city: 'Itapiranga', gender: 'male',
  });
  assert.equal(profile.error, null, profile.error?.message);
  return { id, email, password };
}

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
  const org = await service.from('organizations').insert({ name: `Shirt Approval QA ${label}`, slug: `shirt-approval-qa-${label}-${suffix}`, status: 'active' }).select('id').single();
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

// Usuario da organizacao SEM nenhuma linha em admin_users -- sem permissao
// nenhuma, o mesmo padrao usado no teste de permissao de
// operational-integrity.integration.mjs.
async function makeOrgMemberNoPermission(orgId, label) {
  const user = await createUser(`Sem Permissao ${label}`, '39053344705');
  await service.from('organization_members').insert({ organization_id: orgId, user_id: user.id, is_owner: false, is_active: true });
  return user;
}

// Usuario com EXATAMENTE as permissoes que review_ticket_item_change_request
// exige de verdade pra APROVAR uma solicitacao de CAMISETA -- nao owner, pra
// provar que sao as permissoes, nao o cargo de dono da organizacao, que
// abrem a aprovacao. 'kits.deliver' e checado pela propria
// review_ticket_item_change_request (o gate documentado na auditoria), mas
// ela DELEGA a troca de camiseta pra admin_change_ticket_shirt, que faz sua
// PROPRIA checagem independente de 'inventory.change_participant_shirt' --
// descoberto rodando este teste (falhava com "Sem permissao para trocar
// camiseta" so com kits.deliver). Nenhuma das duas RPCs foi alterada pra
// isso -- e um comportamento pre-existente da RPC reaproveitada, registrado
// aqui e no relatorio final: quem for configurar um cargo "so revisa
// solicitacoes" precisa das DUAS permissoes, nao so kits.deliver.
async function makeOrgMemberWithApprovalPermissions(orgId, label) {
  const suffix = `${Date.now()}-${userCounter++}`;
  let role = await service.from('admin_roles').select('id').eq('code', 'guard_shirt_approval_only').maybeSingle();
  if (!role.data) {
    role = await service.from('admin_roles').insert({ code: 'guard_shirt_approval_only', name: 'Shirt Approval Only', is_system: false, is_active: true }).select('id').single();
  }
  // Ambiente local: admin_permissions e populado por supabase/seed.sql, que
  // nao existe neste repo -- codigos "antigos" (usados em RPC via string,
  // nunca dependeram do catalogo pra a checagem em si) ficam ausentes do
  // catalogo apos um db reset local, mesmo existindo em producao. Upsert
  // idempotente garante as linhas pro teste, sem mexer em nenhuma migration
  // real.
  for (const code of ['kits.deliver', 'inventory.change_participant_shirt']) {
    let permission = await service.from('admin_permissions').select('id').eq('code', code).maybeSingle();
    if (!permission.data) {
      permission = await service.from('admin_permissions').insert({ code, name: code, module: 'operacoes' }).select('id').single();
    }
    assert.equal(permission.error, null, permission.error?.message);
    await service.from('admin_role_permissions').upsert({ role_id: role.data.id, permission_id: permission.data.id }, { onConflict: 'role_id,permission_id' });
  }
  const user = await createUser(`Shirt Approval ${label} ${suffix}`, '16899535009');
  await service.from('admin_users').insert({ user_id: user.id, role_id: role.data.id, is_active: true });
  await service.from('organization_members').insert({ organization_id: orgId, user_id: user.id, is_owner: false, is_active: true });
  return user;
}

async function makeEvent(orgId, name, overrides = {}) {
  const suffix = `${Date.now()}-${userCounter++}`;
  const event = await service.from('events').insert({
    organization_id: orgId, name, year: 2031, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2031-10-10T12:00:00Z', min_age: 0,
    allow_participant_item_changes: true, allow_checkin_during_kit_delivery: true, ...overrides,
  }).select('id').single();
  assert.equal(event.error, null, event.error?.message);
  return event.data.id;
}

// Item de kit tipo camiseta + 2 variantes (G, GG) com estoque proprio cada.
async function makeShirtKitItem(orgId, eventId, { totalG = 5, totalGG = 5 } = {}) {
  const suffix = `${Date.now()}-${userCounter++}`;
  const item = await service.from('event_kit_items').insert({
    event_id: eventId, organization_id: orgId, name: 'Camiseta', slug: `camiseta-${suffix}`,
    item_type: 'shirt', requires_variant: true, allow_participant_change: true, is_active: true,
    shirt_supply_mode: 'stock',
  }).select('id').single();
  assert.equal(item.error, null, item.error?.message);
  const kitItemId = item.data.id;

  const variantG = await service.from('event_kit_item_variants').insert({ kit_item_id: kitItemId, name: 'Adulto', value: 'G', is_active: true, sort_order: 1 }).select('id').single();
  assert.equal(variantG.error, null, variantG.error?.message);
  const variantGG = await service.from('event_kit_item_variants').insert({ kit_item_id: kitItemId, name: 'Adulto', value: 'GG', is_active: true, sort_order: 2 }).select('id').single();
  assert.equal(variantGG.error, null, variantGG.error?.message);

  const invG = await service.from('event_kit_item_variant_inventory').insert({ organization_id: orgId, event_id: eventId, kit_item_id: kitItemId, variant_id: variantG.data.id, total_quantity: totalG });
  assert.equal(invG.error, null, invG.error?.message);
  const invGG = await service.from('event_kit_item_variant_inventory').insert({ organization_id: orgId, event_id: eventId, kit_item_id: kitItemId, variant_id: variantGG.data.id, total_quantity: totalGG });
  assert.equal(invGG.error, null, invGG.error?.message);

  return { kitItemId, variantIdG: variantG.data.id, variantIdGG: variantGG.data.id };
}

// Pedido pago (cortesia) + ticket real via confirm_order_item_and_issue_ticket
// (mesmo caminho de escrita usado pelo app) + camiseta inicial GG definida
// via admin_change_ticket_shirt (RPC canonica real, nao insert direto) +
// titular (owner_user_id) apontado pro requester, pra request_ticket_item_change
// aceitar a solicitacao.
async function makeTicketWithShirt(orgId, eventId, admin, holderName) {
  const orderNumber = `SHQA-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const order = await service.from('orders').insert({
    organization_id: orgId, event_id: eventId, order_number: orderNumber, status: 'confirmed',
    base_amount: 0, final_amount: 0, buyer_type: 'administrative',
  }).select('id').single();
  assert.equal(order.error, null, order.error?.message);

  const item = await service.from('order_items').insert({
    order_id: order.data.id, event_id: eventId, quantity: 1, unit_price: 0, final_amount: 0,
    status: 'confirmed', ownership_status: 'unassigned', holder_full_name: holderName,
  }).select('id').single();
  assert.equal(item.error, null, item.error?.message);

  const payment = await service.from('payments').insert({
    organization_id: orgId, event_id: eventId, order_id: order.data.id, amount: 0, final_amount: 0,
    payment_method: 'courtesy', payment_status: 'paid', paid_at: new Date().toISOString(),
  }).select('id').single();
  assert.equal(payment.error, null, payment.error?.message);
  await service.from('orders').update({ payment_id: payment.data.id }).eq('id', order.data.id);

  const issued = await service.rpc('confirm_order_item_and_issue_ticket', { p_order_item_id: item.data.id });
  assert.equal(issued.error, null, issued.error?.message);
  const ticketId = issued.data;

  const requester = await createUser(holderName, '61495518082');
  const ownerUpdate = await service.from('tickets').update({ owner_user_id: requester.id }).eq('id', ticketId);
  assert.equal(ownerUpdate.error, null, ownerUpdate.error?.message);

  // Camiseta inicial = GG, pelo caminho real (admin_change_ticket_shirt),
  // que materializa participant_kit_items e reserva estoque de GG.
  const adminClient = await clientFor(admin);
  const seed = await adminClient.rpc('admin_change_ticket_shirt', { p_ticket_id: ticketId, p_new_shirt_type: 'Adulto', p_new_shirt_size: 'GG' });
  assert.equal(seed.error, null, seed.error?.message);

  return { orderId: order.data.id, itemId: item.data.id, ticketId, requester };
}

async function currentShirtSize(ticketId) {
  const orderItem = await service.from('order_items').select('shirt_size').eq('id', (await service.from('tickets').select('order_item_id').eq('id', ticketId).single()).data.order_item_id).single();
  return orderItem.data?.shirt_size ?? null;
}

async function inventoryFor(variantId) {
  const row = await service.from('event_kit_item_variant_inventory').select('total_quantity,reserved_quantity,delivered_quantity').eq('variant_id', variantId).single();
  assert.equal(row.error, null, row.error?.message);
  return row.data;
}

// -------------------- testes --------------------

test('1/2. usuário solicita GG -> G e a solicitação fica visível ao admin como pendente', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('request');
  const eventId = await makeEvent(orgId, 'Evento Aprovacao');
  const { kitItemId, variantIdG } = await makeShirtKitItem(orgId, eventId);
  const { ticketId, requester } = await makeTicketWithShirt(orgId, eventId, admin, 'Douglas Hobold');

  const requesterClient = await clientFor(requester);
  const requestResult = await requesterClient.rpc('request_ticket_item_change', {
    p_ticket_id: ticketId, p_kit_item_id: kitItemId, p_requested_variant_id: variantIdG, p_reason: 'Comprei o tamanho errado',
  });
  assert.equal(requestResult.error, null, requestResult.error?.message);
  const requestId = requestResult.data;

  // Visivel ao admin (RLS de ticket_item_change_requests: requested_by ou
  // acesso a organizacao) -- a mesma leitura que /operacoes/solicitacoes faz.
  const adminClient = await clientFor(admin);
  const visible = await adminClient.from('ticket_item_change_requests').select('id,status,ticket_id,kit_item_id,requested_variant_id,current_variant,requested_variant').eq('id', requestId).single();
  assert.equal(visible.error, null, visible.error?.message);
  assert.equal(visible.data.status, 'pending');
  assert.equal(visible.data.ticket_id, ticketId);
  assert.equal(visible.data.requested_variant.value, 'G');
});

test('3/4/5/6/15/16. admin aprova com estoque disponível: tamanho muda, estoque coerente, sem duplicar item, audit log correto', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('approve');
  const eventId = await makeEvent(orgId, 'Evento Aprovacao OK');
  const { kitItemId, variantIdG, variantIdGG } = await makeShirtKitItem(orgId, eventId);
  const { ticketId, requester } = await makeTicketWithShirt(orgId, eventId, admin, 'Ana Aprovada');

  const requesterClient = await clientFor(requester);
  const requestResult = await requesterClient.rpc('request_ticket_item_change', { p_ticket_id: ticketId, p_kit_item_id: kitItemId, p_requested_variant_id: variantIdG });
  assert.equal(requestResult.error, null, requestResult.error?.message);
  const requestId = requestResult.data;

  const invGBefore = await inventoryFor(variantIdG);
  const invGGBefore = await inventoryFor(variantIdGG);
  assert.equal(invGGBefore.reserved_quantity, 1, 'seed inicial deveria ter reservado 1 unidade de GG');

  const adminClient = await clientFor(admin);
  const review = await adminClient.rpc('review_ticket_item_change_request', { p_request_id: requestId, p_decision: 'approved', p_notes: 'Confirmado com o participante' });
  assert.equal(review.error, null, review.error?.message);

  // 4. tamanho muda corretamente
  assert.equal(await currentShirtSize(ticketId), 'G');

  // 5. estoque antigo (GG) libera, novo (G) reserva -- ambos coerentes
  const invGAfter = await inventoryFor(variantIdG);
  const invGGAfter = await inventoryFor(variantIdGG);
  assert.equal(invGAfter.reserved_quantity, invGBefore.reserved_quantity + 1);
  assert.equal(invGGAfter.reserved_quantity, invGGBefore.reserved_quantity - 1);

  // Solicitação marcada approved + reviewed_by/reviewed_at
  const requestRow = await service.from('ticket_item_change_requests').select('status,reviewed_by,reviewed_at,review_notes').eq('id', requestId).single();
  assert.equal(requestRow.data.status, 'approved');
  assert.equal(requestRow.data.reviewed_by, admin.id);
  assert.notEqual(requestRow.data.reviewed_at, null);
  assert.equal(requestRow.data.review_notes, 'Confirmado com o participante');

  // 15. nenhuma duplicação de item de camiseta
  const kitLinks = await service.from('participant_kit_items').select('id').eq('ticket_id', ticketId).eq('kit_item_id', kitItemId);
  assert.equal(kitLinks.data.length, 1, 'deve existir exatamente 1 participant_kit_items para este ticket+item, nunca duplicado');

  // 16. audit log: 1 requested + 1 approved, referenciando o mesmo request_id
  const logs = await service.from('audit_logs').select('action,details').eq('entity_type', 'tickets').eq('entity_id', ticketId).in('action', ['ticket_item_change_requested', 'ticket_item_change_approved']);
  assert.equal(logs.data.length, 2);
  assert.ok(logs.data.every((log) => log.details.request_id === requestId));
});

test('7/8. admin rejeita: motivo obrigatório gravado, estoque e camiseta atual não mudam', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('reject');
  const eventId = await makeEvent(orgId, 'Evento Rejeicao');
  const { kitItemId, variantIdG, variantIdGG } = await makeShirtKitItem(orgId, eventId);
  const { ticketId, requester } = await makeTicketWithShirt(orgId, eventId, admin, 'Bruno Rejeitado');

  const requesterClient = await clientFor(requester);
  const requestResult = await requesterClient.rpc('request_ticket_item_change', { p_ticket_id: ticketId, p_kit_item_id: kitItemId, p_requested_variant_id: variantIdG });
  const requestId = requestResult.data;

  const invGBefore = await inventoryFor(variantIdG);
  const invGGBefore = await inventoryFor(variantIdGG);

  const adminClient = await clientFor(admin);
  const review = await adminClient.rpc('review_ticket_item_change_request', { p_request_id: requestId, p_decision: 'rejected', p_notes: 'Sem estoque no tamanho/opção solicitada' });
  assert.equal(review.error, null, review.error?.message);

  const requestRow = await service.from('ticket_item_change_requests').select('status,reviewed_by,reviewed_at,review_notes').eq('id', requestId).single();
  assert.equal(requestRow.data.status, 'rejected');
  assert.equal(requestRow.data.reviewed_by, admin.id);
  assert.notEqual(requestRow.data.reviewed_at, null);
  assert.equal(requestRow.data.review_notes, 'Sem estoque no tamanho/opção solicitada');

  // Camiseta atual e estoque continuam exatamente como estavam
  assert.equal(await currentShirtSize(ticketId), 'GG');
  const invGAfter = await inventoryFor(variantIdG);
  const invGGAfter = await inventoryFor(variantIdGG);
  assert.equal(invGAfter.reserved_quantity, invGBefore.reserved_quantity);
  assert.equal(invGGAfter.reserved_quantity, invGGBefore.reserved_quantity);

  const rejectLog = await service.from('audit_logs').select('id').eq('entity_type', 'tickets').eq('entity_id', ticketId).eq('action', 'ticket_item_change_rejected');
  assert.equal(rejectLog.data.length, 1);
});

test('9. aprovar sem estoque falha com mensagem estruturada e não altera nada (sem alteração parcial)', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('nostock');
  const eventId = await makeEvent(orgId, 'Evento Sem Estoque');
  const { kitItemId, variantIdG } = await makeShirtKitItem(orgId, eventId, { totalG: 0, totalGG: 5 });
  const { ticketId, requester } = await makeTicketWithShirt(orgId, eventId, admin, 'Carla Sem Estoque');

  const requesterClient = await clientFor(requester);
  const requestResult = await requesterClient.rpc('request_ticket_item_change', { p_ticket_id: ticketId, p_kit_item_id: kitItemId, p_requested_variant_id: variantIdG });
  const requestId = requestResult.data;

  const adminClient = await clientFor(admin);
  const review = await adminClient.rpc('review_ticket_item_change_request', { p_request_id: requestId, p_decision: 'approved' });
  assert.notEqual(review.error, null, 'aprovacao sem estoque fisico de G deve falhar');
  assert.match(review.error.message, /SHIRT_OUT_OF_STOCK/);

  // Nada mudou: solicitacao continua pending, camiseta continua GG.
  const requestRow = await service.from('ticket_item_change_requests').select('status').eq('id', requestId).single();
  assert.equal(requestRow.data.status, 'pending');
  assert.equal(await currentShirtSize(ticketId), 'GG');
});

test('10. duas aprovações concorrentes para a última unidade: apenas uma vence, estoque final coerente', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('race');
  const eventId = await makeEvent(orgId, 'Evento Corrida De Estoque');
  const { kitItemId, variantIdG, variantIdGG } = await makeShirtKitItem(orgId, eventId, { totalG: 1, totalGG: 5 });
  const ticketA = await makeTicketWithShirt(orgId, eventId, admin, 'Duda Corrida A');
  const ticketB = await makeTicketWithShirt(orgId, eventId, admin, 'Duda Corrida B');

  const requesterAClient = await clientFor(ticketA.requester);
  const requesterBClient = await clientFor(ticketB.requester);
  const requestA = await requesterAClient.rpc('request_ticket_item_change', { p_ticket_id: ticketA.ticketId, p_kit_item_id: kitItemId, p_requested_variant_id: variantIdG });
  const requestB = await requesterBClient.rpc('request_ticket_item_change', { p_ticket_id: ticketB.ticketId, p_kit_item_id: kitItemId, p_requested_variant_id: variantIdG });
  assert.equal(requestA.error, null, requestA.error?.message);
  assert.equal(requestB.error, null, requestB.error?.message);

  // Duas aprovações concorrentes de verdade (2 clientes distintos, sem
  // aguardar uma terminar antes de disparar a outra) -- exatamente o cenário
  // da tarefa: resta 1 unidade de G, 2 solicitações pedem G.
  const adminClientA = await clientFor(admin);
  const adminClientB = await clientFor(admin);
  const [reviewA, reviewB] = await Promise.all([
    adminClientA.rpc('review_ticket_item_change_request', { p_request_id: requestA.data, p_decision: 'approved' }),
    adminClientB.rpc('review_ticket_item_change_request', { p_request_id: requestB.data, p_decision: 'approved' }),
  ]);

  const results = [reviewA, reviewB];
  const succeeded = results.filter((r) => r.error === null);
  const failed = results.filter((r) => r.error !== null);
  assert.equal(succeeded.length, 1, 'exatamente uma das duas aprovações concorrentes deve vencer');
  assert.equal(failed.length, 1, 'a outra deve falhar por falta de estoque, nunca as duas passarem');

  // O estoque de G nunca ultrapassa o total fisico (1 unidade) -- e a prova
  // de que a segunda aprovacao nao criou reserva fantasma.
  const invG = await inventoryFor(variantIdG);
  assert.equal(invG.reserved_quantity, 1, 'reserved_quantity de G nunca pode passar de 1 (total fisico)');
  assert.ok(invG.reserved_quantity + invG.delivered_quantity <= invG.total_quantity, 'CHECK de estoque nunca pode ser violado no dado final');

  // Exatamente 1 dos 2 tickets ficou com G; o outro continua GG (rollback real, nao alteracao parcial).
  const sizeA = await currentShirtSize(ticketA.ticketId);
  const sizeB = await currentShirtSize(ticketB.ticketId);
  const changedToG = [sizeA, sizeB].filter((size) => size === 'G').length;
  assert.equal(changedToG, 1, 'exatamente 1 dos 2 tickets deve ter mudado para G');
});

test('11. kit já entregue entre a solicitação e a aprovação bloqueia a aprovação normal', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('delivered');
  const eventId = await makeEvent(orgId, 'Evento Kit Entregue');
  const { kitItemId, variantIdG } = await makeShirtKitItem(orgId, eventId);
  const { ticketId, requester } = await makeTicketWithShirt(orgId, eventId, admin, 'Elis Kit Entregue');

  const requesterClient = await clientFor(requester);
  const requestResult = await requesterClient.rpc('request_ticket_item_change', { p_ticket_id: ticketId, p_kit_item_id: kitItemId, p_requested_variant_id: variantIdG });
  const requestId = requestResult.data;

  // "Enquanto isso" (entre a solicitacao e a revisao), o kit foi entregue de
  // verdade no balcao -- via a RPC real de entrega, nao um UPDATE direto.
  const adminClient = await clientFor(admin);
  const deliver = await adminClient.rpc('deliver_ticket_kit_item', { p_ticket_id: ticketId, p_kit_item_id: kitItemId });
  assert.equal(deliver.error, null, deliver.error?.message);

  const review = await adminClient.rpc('review_ticket_item_change_request', { p_request_id: requestId, p_decision: 'approved' });
  assert.notEqual(review.error, null, 'aprovacao normal deve ser bloqueada apos kit entregue');
  assert.match(review.error.message, /SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION/);

  // A solicitacao NAO fica presa como pending pra sempre so porque a
  // aprovacao normal falhou -- o admin ainda pode rejeitar (fluxo previsto
  // pela tarefa: "exigir fluxo administrativo de correção").
  const reject = await adminClient.rpc('review_ticket_item_change_request', { p_request_id: requestId, p_decision: 'rejected', p_notes: 'Kit já entregue — requer correção administrativa' });
  assert.equal(reject.error, null, reject.error?.message);
});

test('12. check-in realizado entre a solicitação e a aprovação bloqueia a aprovação normal', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('checkin');
  const eventId = await makeEvent(orgId, 'Evento Checkin');
  const { kitItemId, variantIdG } = await makeShirtKitItem(orgId, eventId);
  const { ticketId, requester } = await makeTicketWithShirt(orgId, eventId, admin, 'Fábio Checkin');

  const requesterClient = await clientFor(requester);
  const requestResult = await requesterClient.rpc('request_ticket_item_change', { p_ticket_id: ticketId, p_kit_item_id: kitItemId, p_requested_variant_id: variantIdG });
  const requestId = requestResult.data;

  const adminClient = await clientFor(admin);
  const checkin = await adminClient.rpc('checkin_ticket_entry', { p_ticket_id: ticketId });
  assert.equal(checkin.error, null, checkin.error?.message);

  const review = await adminClient.rpc('review_ticket_item_change_request', { p_request_id: requestId, p_decision: 'approved' });
  assert.notEqual(review.error, null, 'aprovacao normal deve ser bloqueada apos check-in');
  assert.match(review.error.message, /SHIRT_SIZE_CHANGE_LOCKED_AFTER_OPERATION/);
});

test('13/14. usuário sem permissão administrativa não aprova nem rejeita, mesmo chamando a RPC direto', async () => {
  const { orgId, admin } = await makeOrgWithAdmin('noperm');
  const eventId = await makeEvent(orgId, 'Evento Sem Permissao');
  const { kitItemId, variantIdG } = await makeShirtKitItem(orgId, eventId);
  const { ticketId, requester } = await makeTicketWithShirt(orgId, eventId, admin, 'Gustavo Sem Permissao');

  const requesterClient = await clientFor(requester);
  const requestResult = await requesterClient.rpc('request_ticket_item_change', { p_ticket_id: ticketId, p_kit_item_id: kitItemId, p_requested_variant_id: variantIdG });
  const requestId = requestResult.data;

  const noPermissionUser = await makeOrgMemberNoPermission(orgId, 'noperm');
  const noPermissionClient = await clientFor(noPermissionUser);
  const denied = await noPermissionClient.rpc('review_ticket_item_change_request', { p_request_id: requestId, p_decision: 'approved' });
  assert.notEqual(denied.error, null, 'usuario sem kits.deliver deve ser rejeitado pela propria RPC, chamada direta');
  assert.match(denied.error.message, /Sem permissao/i);

  // O proprio titular do ingresso (quem pediu) tambem nao pode revisar a
  // propria solicitacao so por ser o requested_by.
  const selfReview = await requesterClient.rpc('review_ticket_item_change_request', { p_request_id: requestId, p_decision: 'approved' });
  assert.notEqual(selfReview.error, null, 'o proprio solicitante nao tem kits.deliver e nao pode revisar a propria solicitacao');

  // Contraste: um usuario com EXATAMENTE as permissoes certas (nao dono da
  // organizacao) consegue revisar -- prova que sao as permissoes que abrem
  // a porta, nao o cargo.
  const limitedAdmin = await makeOrgMemberWithApprovalPermissions(orgId, 'noperm');
  const limitedClient = await clientFor(limitedAdmin);
  const allowed = await limitedClient.rpc('review_ticket_item_change_request', { p_request_id: requestId, p_decision: 'approved' });
  assert.equal(allowed.error, null, allowed.error?.message);

  const requestRow = await service.from('ticket_item_change_requests').select('status,reviewed_by').eq('id', requestId).single();
  assert.equal(requestRow.data.status, 'approved');
  assert.equal(requestRow.data.reviewed_by, limitedAdmin.id);
});
