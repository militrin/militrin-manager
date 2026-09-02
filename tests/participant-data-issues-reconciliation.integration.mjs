// Caso real (Central de Integridade): "Informe o genero para calcular o
// valor." continuava aberta mesmo depois do genero ja estar preenchido em
// registration_contacts.gender. Causa raiz (auditoria completa no relatorio
// da tarefa): update_registration_contact_from_participant so gravava em
// registration_contacts -- nunca sincronizava a projecao legada
// (participants.gender) nem reavaliava nenhuma participant_data_issues.
// reevaluate_participant_data_issues (a funcao estrutural que ja existia)
// nunca tinha nenhum chamador real, e so sabia ler participants.batch_id/
// ticket_category_id (nunca populados no fluxo contact-first moderno, onde
// isso vive em order_items) nem recalcular preco pro modelo moderno
// (orders/order_items/payments, so sabia o legado payments.participant_id).
//
// 20260928000000_reconcile_participant_data_issues_on_contact_update.sql
// fecha as 3 causas: sincroniza participants a partir de registration_contacts,
// chama reevaluate_participant_data_issues automaticamente, e essa funcao
// passa a resolver lote/categoria via order_items (com fallback pro campo
// legado) e a recalcular order_items/orders/payments quando ha order_item
// moderno vinculado (nunca os dois modelos ao mesmo tempo).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const apiUrl = 'http://127.0.0.1:54321';
const localEnvironment = Object.fromEntries(execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx.cmd supabase status -o env'], { encoding: 'utf8' })
  .split(/\r?\n/).flatMap((line) => { const match = line.match(/^([A-Z_]+)="?([^"\r\n]+)"?$/); return match ? [[match[1], match[2]]] : []; }));
const anonKey = localEnvironment.ANON_KEY;
const serviceKey = localEnvironment.SERVICE_ROLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const service = createClient(apiUrl, serviceKey, options);

async function must(promise, label) {
  const result = await promise;
  assert.equal(result.error, null, `${label}: ${JSON.stringify(result.error)}`);
  return result.data;
}

let counter = 0;
async function buildScenario() {
  const suffix = `${Date.now()}-${counter++}`;
  const org = await must(service.from('organizations').insert({ name: `PDI Reconcile ${suffix}`, slug: `pdi-reconcile-${suffix}` }).select('id').single(), 'org');
  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Reconciliacao', year: 2031, slug: `pdi-reconcile-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2031-10-10T12:00:00Z', min_age: 0,
  }).select('id').single(), 'event');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 200, female_price: 150,
    max_confirmed_registrations: 500, is_active: true,
  }).select('id').single(), 'batch');
  const category = await must(service.from('ticket_categories').insert({
    event_id: event.id, name: 'Geral', slug: `geral-${suffix}`, sort_order: 1, is_active: true,
  }).select('id').single(), 'category');
  await must(service.from('registration_batch_prices').insert({ batch_id: batch.id, ticket_category_id: category.id, male_price: 200, female_price: 150 }), 'price');

  const email = `pdi-reconcile-${suffix}@qa.local`;
  const password = 'SenhaForte!123';
  const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), 'create user');
  const userId = created.user.id;

  const contact = await must(service.from('registration_contacts').insert({
    organization_id: org.id, full_name: 'Pessoa Teste', cpf: '52998224725', birth_date: '1990-01-01',
    phone: '11999990000', email, city: 'Itapiranga', user_id: userId,
  }).select('id').single(), 'contact');

  // Participante "LEGACY projection" tal como o import contact-first cria:
  // gender NULO, batch_id/ticket_category_id NULOS (o lote/categoria reais
  // vivem no order_item, nao aqui) -- reproduz exatamente o formato real.
  const participant = await must(service.from('participants').insert({
    event_id: event.id, organization_id: org.id, registration_contact_id: contact.id, user_id: userId,
    full_name: 'Pessoa Teste', cpf: '52998224725', birth_date: '1990-01-01', gender: null,
    phone: '11999990000', email, city: 'Itapiranga', registration_status: 'pending', reservation_status: 'pending',
  }).select('id').single(), 'participant');

  const order = await must(service.from('orders').insert({
    organization_id: org.id, event_id: event.id, user_id: userId, order_number: `PDI-${suffix}`,
    status: 'confirmed', base_amount: 200, final_amount: 200, buyer_type: 'account',
  }).select('id').single(), 'order');

  const payment = await must(service.from('payments').insert({
    organization_id: org.id, event_id: event.id, order_id: order.id, amount: 200, final_amount: 200,
    payment_method: 'pix', payment_status: 'pending',
  }).select('id').single(), 'payment');
  await must(service.from('orders').update({ payment_id: payment.id }).eq('id', order.id), 'link payment');

  // Preco "generico" usado na importacao (male_price, sem genero informado
  // ainda) -- exatamente o estado real documentado na causa raiz.
  const item = await must(service.from('order_items').insert({
    order_id: order.id, event_id: event.id, participant_id: participant.id, item_kind: 'ticket',
    ticket_category_id: category.id, batch_id: batch.id, quantity: 1, unit_price: 200, discount_amount: 0, final_amount: 200,
    status: 'confirmed', ownership_status: 'assigned', registration_contact_id: contact.id, holder_full_name: 'Pessoa Teste',
  }).select('id').single(), 'order item');

  const issue = await must(service.from('participant_data_issues').insert({
    organization_id: org.id, event_id: event.id, participant_id: participant.id, registration_contact_id: contact.id,
    order_item_id: item.id, field_code: 'gender', issue_type: 'missing_required_for_pricing',
    message: 'Informe o genero para calcular o valor.', blocks_payment: true, blocks_ticket_issuance: true,
    blocks_checkin: false, blocks_kit_delivery: false, status: 'open', resolution_scope: 'user_resolvable',
  }).select('id').single(), 'issue');

  const client = createClient(apiUrl, anonKey, options);
  const signIn = await client.auth.signInWithPassword({ email, password });
  assert.equal(signIn.error, null, signIn.error?.message);

  return { org, event, batch, category, userId, contact, participant, order, payment, item, issue, client };
}

async function openIssues(participantId) {
  const { data, error } = await service.from('participant_data_issues').select('id,status,field_code').eq('participant_id', participantId).eq('status', 'open');
  assert.equal(error, null);
  return data;
}

test('1) importado sem genero: issue de preco por genero comeca aberta', async () => {
  const scenario = await buildScenario();
  const open = await openIssues(scenario.participant.id);
  assert.ok(open.some((i) => i.field_code === 'gender'), 'issue de genero deve comecar aberta');
});

test('2/3) primeiro acesso preenche genero -> issue e resolvida e para de aparecer na Integridade', async () => {
  const scenario = await buildScenario();

  const result = await must(scenario.client.rpc('update_registration_contact_from_participant', {
    p_participant_id: scenario.participant.id,
    p_values: { gender: 'female' },
  }), 'update contact (self-service)');
  assert.equal(result.success, true);

  const open = await openIssues(scenario.participant.id);
  assert.ok(!open.some((i) => i.field_code === 'gender'), 'issue de genero deve estar resolvida');

  const detected = await must(service.rpc('detect_integrity_open_blocking_data_issue', { p_organization_id: scenario.org.id, p_event_id: scenario.event.id }), 'detector');
  assert.ok(!detected.some((row) => row.metadata?.issue_id === scenario.issue.id), 'a Integridade nao pode mais listar esta issue');
});

test('4) edicao administrativa (nao o proprio usuario) tambem preenche genero e resolve a issue', async () => {
  const scenario = await buildScenario();
  // Admin da mesma organizacao, distinto do dono do participante.
  const adminEmail = `pdi-admin-${Date.now()}-${counter++}@qa.local`;
  const adminPassword = 'SenhaForte!123';
  const adminCreated = await must(service.auth.admin.createUser({ email: adminEmail, password: adminPassword, email_confirm: true }), 'create admin');
  let role = await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle();
  if (!role.data) role = await service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single();
  await must(service.from('admin_users').insert({ user_id: adminCreated.user.id, role_id: role.data.id, is_active: true }), 'admin_users');
  await must(service.from('organization_members').insert({ organization_id: scenario.org.id, user_id: adminCreated.user.id, is_owner: true, is_active: true }), 'org member');
  const adminClient = createClient(apiUrl, anonKey, options);
  const adminSignIn = await adminClient.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
  assert.equal(adminSignIn.error, null, adminSignIn.error?.message);

  const result = await must(adminClient.rpc('update_registration_contact_from_participant', {
    p_participant_id: scenario.participant.id,
    p_values: { gender: 'male' },
  }), 'update contact (admin)');
  assert.equal(result.success, true);

  const open = await openIssues(scenario.participant.id);
  assert.ok(!open.some((i) => i.field_code === 'gender'), 'edicao administrativa tambem deve resolver a issue');
});

test('5) genero ainda ausente: atualizar outro campo NAO resolve a issue de genero (continua bloqueando)', async () => {
  const scenario = await buildScenario();
  await must(scenario.client.rpc('update_registration_contact_from_participant', {
    p_participant_id: scenario.participant.id,
    p_values: { city: 'Nova Cidade' },
  }), 'update contact (campo nao relacionado)');

  const open = await openIssues(scenario.participant.id);
  assert.ok(open.some((i) => i.field_code === 'gender'), 'sem genero informado, a issue deve continuar aberta');
});

test('6) issue resolvida nao reaparece por dado historico -- reavaliar de novo sem mudar nada mantem resolvida', async () => {
  const scenario = await buildScenario();
  await must(scenario.client.rpc('update_registration_contact_from_participant', {
    p_participant_id: scenario.participant.id, p_values: { gender: 'female' },
  }), 'primeira atualizacao');
  assert.ok(!(await openIssues(scenario.participant.id)).some((i) => i.field_code === 'gender'));

  // Reavaliacao repetida (idempotente) -- nunca reabre a issue so porque
  // rodou de novo.
  await must(service.rpc('reevaluate_participant_data_issues', { p_participant_id: scenario.participant.id }), 'reevaluate de novo');
  const open = await openIssues(scenario.participant.id);
  assert.ok(!open.some((i) => i.field_code === 'gender'), 'issue nao pode reaparecer numa segunda reavaliacao sem mudanca real');
});

test('7) preco e recalculado no pedido moderno (order_items/orders/payments) quando o genero resolve a ambiguidade', async () => {
  const scenario = await buildScenario();
  const before = await must(service.from('order_items').select('unit_price,final_amount').eq('id', scenario.item.id).single(), 'item antes');
  assert.equal(Number(before.unit_price), 200, 'preco generico (male_price) usado na importacao');

  await must(scenario.client.rpc('update_registration_contact_from_participant', {
    p_participant_id: scenario.participant.id, p_values: { gender: 'female' },
  }), 'informa genero feminino');

  const item = await must(service.from('order_items').select('unit_price,final_amount').eq('id', scenario.item.id).single(), 'item depois');
  assert.equal(Number(item.unit_price), 150, 'deve recalcular para o preco feminino');
  assert.equal(Number(item.final_amount), 150);
  const order = await must(service.from('orders').select('base_amount,final_amount').eq('id', scenario.order.id).single(), 'order depois');
  assert.equal(Number(order.final_amount), 150);
  const payment = await must(service.from('payments').select('amount,final_amount').eq('id', scenario.payment.id).single(), 'payment depois');
  assert.equal(Number(payment.final_amount), 150);
});

test('8) pagamento ja pago NUNCA e alterado pela reconciliacao', async () => {
  const scenario = await buildScenario();
  await must(service.from('payments').update({ payment_status: 'paid', amount: 200, final_amount: 200 }).eq('id', scenario.payment.id), 'marca pago');

  await must(scenario.client.rpc('update_registration_contact_from_participant', {
    p_participant_id: scenario.participant.id, p_values: { gender: 'female' },
  }), 'informa genero apos pagamento');

  const item = await must(service.from('order_items').select('unit_price,final_amount').eq('id', scenario.item.id).single(), 'item apos pagamento');
  assert.equal(Number(item.unit_price), 200, 'pedido ja pago nunca deve ter o preco reescrito');
  const payment = await must(service.from('payments').select('amount,final_amount,payment_status').eq('id', scenario.payment.id).single(), 'payment apos');
  assert.equal(payment.payment_status, 'paid');
  assert.equal(Number(payment.final_amount), 200, 'pagamento ja pago nunca e alterado');

  // A issue de genero ainda deve ser resolvida (o dado pessoal esta correto
  // agora) -- so o preco de um pedido ja pago que fica intocado.
  const open = await openIssues(scenario.participant.id);
  assert.ok(!open.some((i) => i.field_code === 'gender'));
});

test('participants (projecao legada) fica sincronizado com registration_contacts apos a atualizacao', async () => {
  const scenario = await buildScenario();
  await must(scenario.client.rpc('update_registration_contact_from_participant', {
    p_participant_id: scenario.participant.id, p_values: { gender: 'female', city: 'Cidade Nova' },
  }), 'atualiza contato');

  const participant = await must(service.from('participants').select('gender,city').eq('id', scenario.participant.id).single(), 'participant depois');
  assert.equal(participant.gender, 'female');
  assert.equal(participant.city, 'Cidade Nova');
  const contact = await must(service.from('registration_contacts').select('gender,city').eq('id', scenario.contact.id).single(), 'contact depois');
  assert.equal(contact.gender, 'female');
  assert.equal(contact.city, 'Cidade Nova');
});

test('reconciliacao nao mexe em titular/pedido alem do preco -- ownership_status e holder_full_name do item preservados', async () => {
  const scenario = await buildScenario();
  await must(scenario.client.rpc('update_registration_contact_from_participant', {
    p_participant_id: scenario.participant.id, p_values: { gender: 'male' },
  }), 'atualiza contato');

  const item = await must(service.from('order_items').select('ownership_status,holder_full_name,status').eq('id', scenario.item.id).single(), 'item depois');
  assert.equal(item.ownership_status, 'assigned');
  assert.equal(item.holder_full_name, 'Pessoa Teste');
  assert.equal(item.status, 'confirmed');
});

test('retry/idempotencia: rodar reevaluate_participant_data_issues 2x seguidas nao duplica issue nem muda preco de novo', async () => {
  const scenario = await buildScenario();
  await must(scenario.client.rpc('update_registration_contact_from_participant', {
    p_participant_id: scenario.participant.id, p_values: { gender: 'female' },
  }), 'primeira chamada');
  const afterFirst = await must(service.from('order_items').select('final_amount').eq('id', scenario.item.id).single(), 'apos 1a');

  await must(service.rpc('reevaluate_participant_data_issues', { p_participant_id: scenario.participant.id }), 'retry');
  const afterSecond = await must(service.from('order_items').select('final_amount').eq('id', scenario.item.id).single(), 'apos retry');
  assert.equal(Number(afterSecond.final_amount), Number(afterFirst.final_amount));

  const open = await openIssues(scenario.participant.id);
  const genderIssues = open.filter((i) => i.field_code === 'gender');
  assert.equal(genderIssues.length, 0);
});
