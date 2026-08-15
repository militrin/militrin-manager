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

test('checkout publico nunca deixa a mesma pessoa virar titular de dois ingressos ativos no mesmo evento', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const anon = createClient(apiUrl, anonKey, options);
  const suffix = Date.now();
  const email = `self-holder-${suffix}@example.test`;
  const password = 'Self-holder-local-only-123!';
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null, created.error?.message);
  const userId = created.data.user.id;

  const org = await service.from('organizations').insert({ name: 'Self Holder', slug: `self-holder-${suffix}`, status: 'active' }).select('id').single();
  assert.equal(org.error, null, org.error?.message);
  const event = await service.from('events').insert({
    organization_id: org.data.id, name: 'Evento Self Holder', year: 2031, slug: `evento-self-holder-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2031-10-10T12:00:00Z', min_age: 0,
  }).select('id').single();
  assert.equal(event.error, null, event.error?.message);
  const category = await service.from('ticket_categories').insert({ event_id: event.data.id, name: 'Geral', slug: `geral-${suffix}`, is_active: true }).select('id').single();
  const batch = await service.from('registration_batches').insert({
    event_id: event.data.id, name: 'Lote 1', sequence_number: 1, male_price: 100, female_price: 90, max_confirmed_registrations: 100, is_active: true,
  }).select('id').single();
  assert.equal(category.error, null, category.error?.message);
  assert.equal(batch.error, null, batch.error?.message);
  const price = await service.from('registration_batch_prices').insert({ batch_id: batch.data.id, ticket_category_id: category.data.id, male_price: 100, female_price: 90 });
  assert.equal(price.error, null, price.error?.message);

  const buyerCpf = '52998224725';
  // get_public_buyer_ticket_holder_status resolve o CPF do ator autenticado via
  // customer_profiles (preenchido pelo fluxo real de "meus dados" antes do
  // checkout) -- nunca a partir do payload da propria chamada RPC, entao o
  // cenario de teste precisa replicar esse pre-requisito.
  const profile = await service.from('customer_profiles').insert({ user_id: userId, cpf: buyerCpf, full_name: 'Comprador Titular' });
  assert.equal(profile.error, null, profile.error?.message);

  const session = await anon.auth.signInWithPassword({ email, password });
  assert.equal(session.error, null, session.error?.message);
  const rpcBase = {
    p_event_id: event.data.id, p_ticket_category_id: category.data.id, p_gender: 'male', p_payment_method: 'courtesy',
    p_buyer_full_name: 'Comprador Titular', p_buyer_cpf: buyerCpf, p_buyer_birth_date: '1990-01-01', p_buyer_gender: 'male',
    p_buyer_phone: '11999990000', p_buyer_email: email, p_buyer_city: 'Sao Paulo', p_limit_per_order: 10,
  };

  const statusBefore = await anon.rpc('get_public_buyer_ticket_holder_status', { p_event_id: event.data.id });
  assert.equal(statusBefore.error, null, statusBefore.error?.message);
  assert.equal(statusBefore.data[0].already_holds_active_ticket, false);

  const first = await anon.rpc('create_multi_ticket_order_checkout', {
    ...rpcBase, p_quantity: 1, p_assign_first_to_buyer: true, p_client_request_id: `self-first-${suffix}`,
    p_items: [{ pricing_gender: 'male', ownership_mode: 'self', ownership_status: 'assigned' }],
  });
  assert.equal(first.error, null, first.error?.message);
  const firstOrderId = first.data[0].order_id;

  const firstItem = await service.from('order_items').select('id,participant_id,registration_contact_id,ownership_status,holder_full_name')
    .eq('order_id', firstOrderId).eq('item_position', 1).single();
  assert.equal(firstItem.error, null, firstItem.error?.message);
  assert.equal(firstItem.data.ownership_status, 'assigned');
  assert.ok(firstItem.data.registration_contact_id, 'item "self" deve ficar ancorado a um registration_contacts, nao so a um participant');
  assert.equal(firstItem.data.holder_full_name, 'Comprador Titular');

  const contact = await service.from('registration_contacts').select('id').eq('organization_id', org.data.id).eq('cpf', buyerCpf).single();
  assert.equal(contact.error, null, contact.error?.message);
  assert.equal(firstItem.data.registration_contact_id, contact.data.id);

  const statusAfter = await anon.rpc('get_public_buyer_ticket_holder_status', { p_event_id: event.data.id });
  assert.equal(statusAfter.error, null, statusAfter.error?.message);
  assert.equal(statusAfter.data[0].already_holds_active_ticket, true);

  // Segunda tentativa de titularidade "self" no mesmo evento: deve ser rejeitada
  // atomicamente pelo backend (nao apenas escondida no frontend). A checagem
  // canonica assert_ticket_holder_contact_available deve abortar toda a
  // transacao antes de qualquer pedido/pagamento/reserva ficar visivel.
  const second = await anon.rpc('create_multi_ticket_order_checkout', {
    ...rpcBase, p_quantity: 1, p_assign_first_to_buyer: true, p_client_request_id: `self-second-${suffix}`,
    p_items: [{ pricing_gender: 'male', ownership_mode: 'self', ownership_status: 'assigned' }],
  });
  assert.ok(second.error, 'segunda titularidade self deveria ser rejeitada');
  assert.match(second.error.message, /HOLDER_ALREADY_HAS_TICKET_FOR_EVENT/);

  const ordersAfterRejection = await service.from('orders').select('id').eq('event_id', event.data.id);
  assert.equal(ordersAfterRejection.data.length, 1, 'pedido duplicado rejeitado nao pode deixar rastro visivel (orders)');

  // Um titular ainda pode COMPRAR/gerenciar varios ingressos para terceiros
  // (buyer != titular). A restricao e sobre titularidade, nao sobre compra.
  const forThirdParty = await anon.rpc('create_multi_ticket_order_checkout', {
    ...rpcBase, p_quantity: 1, p_assign_first_to_buyer: false, p_client_request_id: `self-third-party-${suffix}`,
    p_items: [{ pricing_gender: 'female', ownership_mode: 'named', ownership_status: 'unassigned', holder_full_name: 'Terceira Pessoa', holder_cpf: '11144477735' }],
  });
  assert.equal(forThirdParty.error, null, forThirdParty.error?.message);

  // Cancelar o ingresso original libera a titularidade: um ingresso cancelado
  // nao deve bloquear um novo ingresso "self" para a mesma pessoa no mesmo
  // evento (mesma semantica ja usada por registration_contact_has_active_ticket
  // em todos os outros fluxos administrativos).
  const firstTicket = await service.from('tickets').select('id').eq('order_id', firstOrderId).single();
  assert.equal(firstTicket.error, null, firstTicket.error?.message);
  const cancelled = await service.from('tickets').update({ status: 'cancelled' }).eq('id', firstTicket.data.id);
  assert.equal(cancelled.error, null, cancelled.error?.message);

  const statusAfterCancel = await anon.rpc('get_public_buyer_ticket_holder_status', { p_event_id: event.data.id });
  assert.equal(statusAfterCancel.error, null, statusAfterCancel.error?.message);
  assert.equal(statusAfterCancel.data[0].already_holds_active_ticket, false);

  const third = await anon.rpc('create_multi_ticket_order_checkout', {
    ...rpcBase, p_quantity: 1, p_assign_first_to_buyer: true, p_client_request_id: `self-after-cancel-${suffix}`,
    p_items: [{ pricing_gender: 'male', ownership_mode: 'self', ownership_status: 'assigned' }],
  });
  assert.equal(third.error, null, third.error?.message);

  await service.auth.admin.deleteUser(userId);
});

test('quantidade alta (5) no mesmo pedido: mesmo com payload manipulado tentando marcar mais de uma posicao como assigned, so a posicao 1 vira titular', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const anon = createClient(apiUrl, anonKey, options);
  const suffix = Date.now();
  const email = `self-holder-qty5-${suffix}@example.test`;
  const password = 'Self-holder-local-only-123!';
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null, created.error?.message);
  const userId = created.data.user.id;

  const org = await service.from('organizations').insert({ name: 'Self Holder Qty5', slug: `self-holder-qty5-${suffix}`, status: 'active' }).select('id').single();
  const event = await service.from('events').insert({
    organization_id: org.data.id, name: 'Evento Self Holder Qty5', year: 2031, slug: `evento-self-holder-qty5-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2031-10-10T12:00:00Z', min_age: 0,
  }).select('id').single();
  const category = await service.from('ticket_categories').insert({ event_id: event.data.id, name: 'Geral', slug: `geral-qty5-${suffix}`, is_active: true }).select('id').single();
  const batch = await service.from('registration_batches').insert({
    event_id: event.data.id, name: 'Lote 1', sequence_number: 1, male_price: 100, female_price: 90, max_confirmed_registrations: 100, is_active: true,
  }).select('id').single();
  await service.from('registration_batch_prices').insert({ batch_id: batch.data.id, ticket_category_id: category.data.id, male_price: 100, female_price: 90 });

  const buyerCpf = '52998224725';
  await service.from('customer_profiles').insert({ user_id: userId, cpf: buyerCpf, full_name: 'Comprador Titular Qty5' });
  const session = await anon.auth.signInWithPassword({ email, password });
  assert.equal(session.error, null, session.error?.message);

  // Payload manipulado: tenta marcar as posicoes 1 E 3 como "assigned"/self.
  // create_multi_ticket_order_checkout_legacy so honra ownership_status='assigned'
  // para item_position=1 quando p_assign_first_to_buyer=true (qualquer outra
  // posicao com 'assigned' no payload e forcada de volta para 'unassigned') --
  // e materialize_self_checkout_holder so processa item_position=1. Portanto
  // nenhuma quantidade, por maior que seja, pode resultar em mais de um titular
  // "self" no mesmo pedido.
  const result = await anon.rpc('create_multi_ticket_order_checkout', {
    p_event_id: event.data.id, p_ticket_category_id: category.data.id, p_gender: 'male', p_payment_method: 'courtesy',
    p_buyer_full_name: 'Comprador Titular Qty5', p_buyer_cpf: buyerCpf, p_buyer_birth_date: '1990-01-01', p_buyer_gender: 'male',
    p_buyer_phone: '11999990000', p_buyer_email: email, p_buyer_city: 'Sao Paulo', p_limit_per_order: 10,
    p_quantity: 5, p_assign_first_to_buyer: true, p_client_request_id: `self-qty5-${suffix}`,
    p_items: [
      { pricing_gender: 'male', ownership_mode: 'self', ownership_status: 'assigned' },
      { pricing_gender: 'male', ownership_mode: 'unassigned', ownership_status: 'unassigned' },
      { pricing_gender: 'male', ownership_mode: 'self', ownership_status: 'assigned' },
      { pricing_gender: 'male', ownership_mode: 'unassigned', ownership_status: 'unassigned' },
      { pricing_gender: 'male', ownership_mode: 'unassigned', ownership_status: 'unassigned' },
    ],
  });
  assert.equal(result.error, null, result.error?.message);
  const orderId = result.data[0].order_id;

  const items = await service.from('order_items').select('item_position,ownership_status,registration_contact_id')
    .eq('order_id', orderId).order('item_position', { ascending: true });
  assert.equal(items.error, null, items.error?.message);
  assert.equal(items.data.length, 5);
  const assignedItems = items.data.filter((item) => item.ownership_status === 'assigned');
  assert.equal(assignedItems.length, 1, 'apenas a posicao 1 pode ficar assigned, mesmo com o payload pedindo duas');
  assert.equal(assignedItems[0].item_position, 1);
  assert.ok(assignedItems[0].registration_contact_id, 'a posicao 1 titular deve estar ancorada a um registration_contacts');
  assert.ok(items.data.slice(1).every((item) => item.ownership_status !== 'assigned' && item.registration_contact_id === null));

  await service.auth.admin.deleteUser(userId);
});

test('dois titulares diferentes (named) no mesmo pedido: ambos permitidos, cada um ancorado ao proprio cadastro', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const anon = createClient(apiUrl, anonKey, options);
  const suffix = Date.now();
  const email = `buyer-two-named-${suffix}@example.test`;
  const password = 'Two-named-local-only-123!';
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null, created.error?.message);
  const userId = created.data.user.id;

  const org = await service.from('organizations').insert({ name: 'Two Named', slug: `two-named-${suffix}`, status: 'active' }).select('id').single();
  const event = await service.from('events').insert({
    organization_id: org.data.id, name: 'Evento Two Named', year: 2031, slug: `evento-two-named-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2031-10-10T12:00:00Z', min_age: 0,
  }).select('id').single();
  const category = await service.from('ticket_categories').insert({ event_id: event.data.id, name: 'Geral', slug: `geral-two-named-${suffix}`, is_active: true }).select('id').single();
  const batch = await service.from('registration_batches').insert({
    event_id: event.data.id, name: 'Lote 1', sequence_number: 1, male_price: 100, female_price: 90, max_confirmed_registrations: 100, is_active: true,
  }).select('id').single();
  await service.from('registration_batch_prices').insert({ batch_id: batch.data.id, ticket_category_id: category.data.id, male_price: 100, female_price: 90 });

  const buyerCpf = '52998224725';
  await service.from('customer_profiles').insert({ user_id: userId, cpf: buyerCpf, full_name: 'Comprador Two Named' });
  const session = await anon.auth.signInWithPassword({ email, password });
  assert.equal(session.error, null, session.error?.message);

  const result = await anon.rpc('create_multi_ticket_order_checkout', {
    p_event_id: event.data.id, p_ticket_category_id: category.data.id, p_gender: 'male', p_payment_method: 'courtesy',
    p_buyer_full_name: 'Comprador Two Named', p_buyer_cpf: buyerCpf, p_buyer_birth_date: '1990-01-01', p_buyer_gender: 'male',
    p_buyer_phone: '11999990000', p_buyer_email: email, p_buyer_city: 'Sao Paulo', p_limit_per_order: 10,
    p_quantity: 2, p_assign_first_to_buyer: false, p_client_request_id: `two-named-${suffix}`,
    p_items: [
      { pricing_gender: 'male', ownership_mode: 'named', ownership_status: 'unassigned', holder_full_name: 'Pessoa Um', holder_cpf: '11144477735' },
      { pricing_gender: 'female', ownership_mode: 'named', ownership_status: 'unassigned', holder_full_name: 'Pessoa Dois', holder_cpf: '39053344705' },
    ],
  });
  assert.equal(result.error, null, result.error?.message);
  const orderId = result.data[0].order_id;

  const items = await service.from('order_items').select('item_position,holder_full_name,registration_contact_id')
    .eq('order_id', orderId).order('item_position', { ascending: true });
  assert.equal(items.error, null, items.error?.message);
  assert.equal(items.data.length, 2);
  assert.ok(items.data[0].registration_contact_id, 'primeiro titular nomeado deve estar ancorado a um cadastro');
  assert.ok(items.data[1].registration_contact_id, 'segundo titular nomeado deve estar ancorado a um cadastro');
  assert.notEqual(items.data[0].registration_contact_id, items.data[1].registration_contact_id, 'duas pessoas diferentes devem ter cadastros distintos, nenhuma bloqueada pela outra');

  await service.auth.admin.deleteUser(userId);
});
