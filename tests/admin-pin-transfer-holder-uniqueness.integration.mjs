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

// Cobre a rota de titularidade que NAO passava pela checagem canonica ate esta
// correcao: admin_transfer_ticket_by_pin (usada pela tela administrativa de
// "Definir titular"/"Transferir titularidade" via PIN, ver
// src/app/minha-conta/actions.ts:adminTransferTicketByPinAction) chama
// change_ticket_holder_by_pin_internal com p_admin_override=true. Essa funcao
// resolve o titular de destino por participants.user_id (arquitetura anterior
// ao contact-first) e nunca chamava assert_ticket_holder_contact_available --
// um administrador podia transferir/definir um ingresso para alguem que ja
// fosse titular de outro ingresso ativo no mesmo evento e nada bloqueava.
test('transferencia administrativa por PIN para pessoa ja titular de outro ingresso ativo no mesmo evento e rejeitada; remover o titular anterior libera a transferencia', async () => {
  const service = createClient(apiUrl, serviceKey, options);
  const suffix = Date.now();

  const org = await service.from('organizations').insert({ name: 'Admin PIN Transfer', slug: `admin-pin-transfer-${suffix}`, status: 'active' }).select('id').single();
  assert.equal(org.error, null, org.error?.message);
  const event = await service.from('events').insert({
    organization_id: org.data.id, name: 'Evento Admin PIN Transfer', year: 2031, slug: `evento-admin-pin-transfer-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2031-10-10T12:00:00Z', min_age: 0,
  }).select('id').single();
  assert.equal(event.error, null, event.error?.message);
  const category = await service.from('ticket_categories').insert({ event_id: event.data.id, name: 'Geral', slug: `geral-admin-pin-${suffix}`, is_active: true }).select('id').single();
  const batch = await service.from('registration_batches').insert({
    event_id: event.data.id, name: 'Lote 1', sequence_number: 1, male_price: 100, female_price: 100, max_confirmed_registrations: 100, is_active: true,
  }).select('id').single();
  assert.equal(category.error, null, category.error?.message);
  assert.equal(batch.error, null, batch.error?.message);
  await service.from('registration_batch_prices').insert({ batch_id: batch.data.id, ticket_category_id: category.data.id, male_price: 100, female_price: 100 });

  // Ator administrativo com permissao 'participants.edit_basic' na organizacao
  // (mesmo padrao de fixture usado em tests/admin-dashboard-runtime.integration.mjs).
  const adminCreated = await service.auth.admin.createUser({ email: `admin-pin-${suffix}@example.test`, password: 'Admin-pin-local-only-123!', email_confirm: true });
  assert.equal(adminCreated.error, null, adminCreated.error?.message);
  const adminUserId = adminCreated.data.user.id;
  let role = await service.from('admin_roles').select('id').eq('code', 'owner').maybeSingle();
  if (!role.data) role = await service.from('admin_roles').insert({ code: 'owner', name: 'Owner', is_system: true, is_active: true }).select('id').single();
  assert.equal(role.error, null, role.error?.message);
  assert.equal((await service.from('admin_users').insert({ user_id: adminUserId, role_id: role.data.id, is_active: true })).error, null);
  assert.equal((await service.from('organization_members').insert({ organization_id: org.data.id, user_id: adminUserId, role_id: role.data.id, is_owner: true, is_active: true })).error, null);
  const admin = createClient(apiUrl, anonKey, options);
  const adminSignIn = await admin.auth.signInWithPassword({ email: `admin-pin-${suffix}@example.test`, password: 'Admin-pin-local-only-123!' });
  assert.equal(adminSignIn.error, null, adminSignIn.error?.message);

  // Pessoa "A": ja e titular de um ingresso ativo (ticket 1, emitido via
  // issue_manual_ticket_batch -- rota ja corretamente protegida, usada aqui so
  // para preparar o cenario) e possui uma conta Nexora (customer_profiles) com
  // PIN publico, usada pelo fluxo administrativo de transferencia.
  const personACreated = await service.auth.admin.createUser({ email: `pessoa-a-${suffix}@example.test`, password: 'Pessoa-a-local-only-123!', email_confirm: true });
  assert.equal(personACreated.error, null, personACreated.error?.message);
  const personAUserId = personACreated.data.user.id;
  const personACpf = '52998224725';
  const personAContact = await service.from('registration_contacts').insert({
    organization_id: org.data.id, full_name: 'Pessoa A Titular', cpf: personACpf, birth_date: '1990-01-01', gender: 'male', phone: '11999990000', email: `pessoa-a-${suffix}@example.test`, city: 'Sao Paulo',
  }).select('id').single();
  assert.equal(personAContact.error, null, personAContact.error?.message);
  const personAProfile = await service.from('customer_profiles').insert({ user_id: personAUserId, cpf: personACpf, full_name: 'Pessoa A Titular' }).select('public_pin').single();
  assert.equal(personAProfile.error, null, personAProfile.error?.message);
  const personAPin = personAProfile.data.public_pin;
  assert.match(personAPin, /^[A-Z0-9]{10}$/, 'public_pin deve ser gerado automaticamente pelo default da coluna');

  const ticket1 = await admin.rpc('issue_manual_ticket_batch', {
    p_registration_contact_id: personAContact.data.id, p_event_id: event.data.id, p_ticket_category_id: category.data.id,
    p_batch_id: batch.data.id, p_quantity: 1, p_pricing_gender: 'male', p_shirt_type: null, p_shirt_size: null,
    p_payment_method: 'courtesy', p_notes: null, p_assign_holder: true,
  });
  assert.equal(ticket1.error, null, ticket1.error?.message);
  const ticket1Id = ticket1.data[0].ticket_id;

  // Ticket 2: emitido sem titular (p_assign_holder=false) -- e este ticket que
  // sera alvo da tentativa de transferencia administrativa para a Pessoa A.
  const ticket2 = await admin.rpc('issue_manual_ticket_batch', {
    p_registration_contact_id: personAContact.data.id, p_event_id: event.data.id, p_ticket_category_id: category.data.id,
    p_batch_id: batch.data.id, p_quantity: 1, p_pricing_gender: 'male', p_shirt_type: null, p_shirt_size: null,
    p_payment_method: 'courtesy', p_notes: null, p_assign_holder: false,
  });
  assert.equal(ticket2.error, null, ticket2.error?.message);
  const ticket2Id = ticket2.data[0].ticket_id;

  // A Pessoa A ja e titular do ticket 1 -- a transferencia administrativa do
  // ticket 2 para ela pelo PIN deve ser rejeitada atomicamente pelo backend,
  // nao apenas escondida na UI.
  const rejected = await admin.rpc('admin_transfer_ticket_by_pin', {
    p_ticket_id: ticket2Id, p_pin: personAPin, p_reason: 'teste titularidade', p_operation: 'holder_assigned',
  });
  assert.ok(rejected.error, 'transferencia administrativa para pessoa ja titular deveria ser rejeitada');
  assert.match(rejected.error.message, /HOLDER_ALREADY_HAS_TICKET_FOR_EVENT/);

  const ticket2AfterRejection = await service.from('order_items').select('participant_id').eq('id',
    (await service.from('tickets').select('order_item_id').eq('id', ticket2Id).single()).data.order_item_id,
  ).single();
  assert.equal(ticket2AfterRejection.data.participant_id, null, 'ticket 2 deve permanecer sem titular apos a rejeicao');

  // Remover a titularidade do ticket 1 (nao cancelar o ingresso -- so o
  // vinculo de titular) deve liberar a Pessoa A para se tornar titular do
  // ticket 2: mesma semantica de registration_contact_has_active_ticket usada
  // em todo o sistema.
  const removed = await admin.rpc('admin_set_ticket_holder_contact', {
    p_ticket_id: ticket1Id, p_registration_contact_id: null, p_reason_code: 'administrative_adjustment', p_reason_text: null,
  });
  assert.equal(removed.error, null, removed.error?.message);

  const allowed = await admin.rpc('admin_transfer_ticket_by_pin', {
    p_ticket_id: ticket2Id, p_pin: personAPin, p_reason: 'teste titularidade liberada', p_operation: 'holder_assigned',
  });
  assert.equal(allowed.error, null, allowed.error?.message);

  const ticket2AfterAllowed = await service.from('order_items').select('participant_id').eq('id',
    (await service.from('tickets').select('order_item_id').eq('id', ticket2Id).single()).data.order_item_id,
  ).single();
  assert.ok(ticket2AfterAllowed.data.participant_id, 'ticket 2 deve ter titular apos a titularidade anterior ser removida');

  await service.auth.admin.deleteUser(adminUserId);
  await service.auth.admin.deleteUser(personAUserId);
});
