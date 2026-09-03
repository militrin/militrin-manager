// Fecha os 3 P0 do Release Gate #2 contra Postgres local.
// Nao e teste estatico: prova ATTACK/LEGITIMATE/RPC/IDOR no banco.
import test from 'node:test';
import assert from 'node:assert/strict';
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
  // Sempre o stack local. Nao herdar NEXT_PUBLIC_SUPABASE_* de .env.local —
  // esse arquivo aponta para producao e nao pode receber fixtures de ataque.
  return {
    url: 'http://127.0.0.1:54321',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    serviceKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
  };
}

async function buildFixture() {
  const env = await environment();
  const service = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anonKey = env.anonKey;
  const password = 'SenhaForte!123';

  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }

  async function clientFor(email) {
    const client = createClient(env.url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`login ${email}: ${signIn.error.message}`);
    return client;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const org = await must(service.from('organizations').insert({
    name: 'P0 Identity Org', slug: `p0-identity-${suffix}`, status: 'active',
  }).select('id').single(), 'org');
  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento P0 Identity', year: 2026, slug: `p0-identity-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const category = await must(service.from('ticket_categories').insert({
    event_id: event.id, name: 'Geral', slug: `p0-geral-${suffix}`, is_active: true,
  }).select('id').single(), 'category');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100,
    max_confirmed_registrations: 100, is_active: true,
  }).select('id').single(), 'batch');

  let userCount = 0;
  async function makeAuthUser(label, cpf = generateValidCpf()) {
    userCount += 1;
    const email = `p0-${label}-${suffix}-${userCount}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `create ${label}`);
    await must(service.from('customer_profiles').upsert({
      user_id: created.user.id, cpf, full_name: label, birth_date: '1990-05-05',
      phone: '11999990001', city: 'Itapiranga', gender: 'male',
    }, { onConflict: 'user_id' }), `${label} profile`);
    return { userId: created.user.id, email, cpf, client: await clientFor(email) };
  }

  async function makeAdmin(label) {
    const account = await makeAuthUser(label);
    const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
    await must(service.from('organization_members').insert({
      organization_id: org.id, user_id: account.userId, is_owner: true, is_active: true,
    }), `${label} org member`);
    await must(service.from('admin_users').insert({
      user_id: account.userId, role_id: ownerRole.id, is_active: true,
    }), `${label} admin_users`);
    return account;
  }

  async function createImportedIdentity(label) {
    const cpf = generateValidCpf();
    const email = `imported-${label}-${suffix}@qa.local`;
    const contact = await must(service.from('registration_contacts').insert({
      organization_id: org.id, full_name: label, cpf, birth_date: '1988-03-15',
      gender: 'male', phone: '11988887777', email, city: 'Itapiranga',
    }).select('id').single(), `contact ${label}`);
    const participant = await must(service.from('participants').insert({
      organization_id: org.id, event_id: event.id, registration_contact_id: contact.id,
      full_name: label, cpf, email, birth_date: '1988-03-15', gender: 'male',
      phone: '11988887777', city: 'Itapiranga', registration_status: 'confirmed',
    }).select('id').single(), `participant ${label}`);
    const order = await must(service.from('orders').insert({
      organization_id: org.id, event_id: event.id, participant_id: participant.id,
      order_number: `P0-${label}-${suffix}-${Math.floor(Math.random() * 100000)}`,
      status: 'confirmed', base_amount: 100, final_amount: 100, buyer_type: 'administrative',
    }).select('id').single(), `order ${label}`);
    const item = await must(service.from('order_items').insert({
      order_id: order.id, event_id: event.id, participant_id: participant.id,
      registration_contact_id: contact.id, item_kind: 'ticket', ticket_category_id: category.id,
      batch_id: batch.id, quantity: 1, unit_price: 100, discount_amount: 0, final_amount: 100,
      status: 'confirmed', ownership_status: 'assigned', holder_full_name: label,
    }).select('id').single(), `item ${label}`);
    const ticket = await must(service.from('tickets').insert({
      order_id: order.id, order_item_id: item.id, participant_id: participant.id,
      event_id: event.id, organization_id: org.id, status: 'active',
    }).select('id,owner_user_id').single(), `ticket ${label}`);
    await must(service.from('participation_history').insert({
      event_id: event.id, participant_id: participant.id, registration_contact_id: contact.id,
      event_year: 2026, full_name: label, cpf, email, status: 'confirmed', source: 'import',
    }), `history ${label}`);
    return { contact, participant, order, item, ticket, cpf, email };
  }

  async function ownershipSnapshot(identity) {
    const contact = await must(service.from('registration_contacts').select('id,user_id').eq('id', identity.contact.id).single(), 'contact snap');
    const participant = await must(service.from('participants').select('id,user_id').eq('id', identity.participant.id).single(), 'participant snap');
    const ticket = await must(service.from('tickets').select('id,owner_user_id').eq('id', identity.ticket.id).single(), 'ticket snap');
    return { contact, participant, ticket };
  }

  async function correlateInviteToNewAccount(inviteId, email, label, cpf) {
    const account = await makeAuthUser(label, cpf);
    await must(service.auth.admin.updateUserById(account.userId, { email }), `update email ${label}`);
    await must(service.from('customer_profiles').update({ cpf }).eq('user_id', account.userId), `cpf ${label}`);
    await must(service.from('participant_account_invites').update({ auth_user_id: account.userId }).eq('id', inviteId), 'correlate invite');
    return { ...account, email, client: await clientFor(email) };
  }

  return {
    service, org, event, category, batch, must, makeAuthUser, makeAdmin, createImportedIdentity,
    ownershipSnapshot, correlateInviteToNewAccount, suffix, url: env.url, anonKey, password,
  };
}

const fx = await buildFixture();

test('ATTACK A: CPF importado sem invite nao assume cadastro, participant nem ticket', async () => {
  const identity = await fx.createImportedIdentity('alvo-cpf');
  const attacker = await fx.makeAuthUser('atacante-cpf', identity.cpf);

  const conflict = await attacker.client.rpc('find_conflicting_registration_contact', {
    p_cpf: identity.cpf,
    p_exclude_user_id: attacker.userId,
    p_organization_id: fx.org.id,
  });
  assert.equal(conflict.error, null, conflict.error?.message);
  const conflictRow = Array.isArray(conflict.data) ? conflict.data[0] : conflict.data;
  assert.equal(conflictRow.has_conflict, true, 'CPF importado protegido deve ser conflito sem convite');

  const ensure = await attacker.client.rpc('ensure_registration_contact_for_user', {
    p_user_id: attacker.userId,
    p_organization_id: fx.org.id,
  });
  assert.ok(ensure.error, 'ensure sem invite nao pode anexar cadastro importado');
  assert.match(ensure.error.message, /CPF_ALREADY_LINKED_TO_ANOTHER_USER|REGISTRATION_CONTACT_REQUIRES_INVITE/);

  const after = await fx.ownershipSnapshot(identity);
  assert.equal(after.contact.user_id, null);
  assert.equal(after.participant.user_id, null);
  assert.equal(after.ticket.owner_user_id, null);
});

test('LEGITIMO 1/3: invite + claim + ensure associa cadastro e reconcilia owner_user_id', async () => {
  const admin = await fx.makeAdmin('admin-claim');
  const identity = await fx.createImportedIdentity('legitimo');
  const prepared = await admin.client.rpc('prepare_registration_contact_account_invite', {
    p_registration_contact_id: identity.contact.id,
  });
  assert.equal(prepared.error, null, prepared.error?.message);
  const preparedRow = Array.isArray(prepared.data) ? prepared.data[0] : prepared.data;
  const holder = await fx.correlateInviteToNewAccount(preparedRow.invite_id, identity.email, 'holder-claim', identity.cpf);

  const claim = await holder.client.rpc('claim_registration_contact_account_invite', {
    p_invite_id: preparedRow.invite_id,
  });
  assert.equal(claim.error, null, claim.error?.message);

  const ensure = await holder.client.rpc('ensure_registration_contact_for_user', {
    p_user_id: holder.userId,
    p_organization_id: fx.org.id,
  });
  assert.equal(ensure.error, null, ensure.error?.message);
  assert.equal(ensure.data, identity.contact.id);

  const after = await fx.ownershipSnapshot(identity);
  assert.equal(after.contact.user_id, holder.userId);
  assert.equal(after.participant.user_id, holder.userId);
  assert.equal(after.ticket.owner_user_id, holder.userId);
});

test('LEGITIMO 2: claim/ensure repetidos permanecem idempotentes', async () => {
  const admin = await fx.makeAdmin('admin-retry');
  const identity = await fx.createImportedIdentity('retry');
  const prepared = await admin.client.rpc('prepare_registration_contact_account_invite', {
    p_registration_contact_id: identity.contact.id,
  });
  const preparedRow = Array.isArray(prepared.data) ? prepared.data[0] : prepared.data;
  const holder = await fx.correlateInviteToNewAccount(preparedRow.invite_id, identity.email, 'holder-retry', identity.cpf);

  const firstClaim = await holder.client.rpc('claim_registration_contact_account_invite', { p_invite_id: preparedRow.invite_id });
  assert.equal(firstClaim.error, null, firstClaim.error?.message);
  const firstEnsure = await holder.client.rpc('ensure_registration_contact_for_user', {
    p_user_id: holder.userId, p_organization_id: fx.org.id,
  });
  assert.equal(firstEnsure.error, null, firstEnsure.error?.message);

  const retryClaim = await holder.client.rpc('claim_registration_contact_account_invite', { p_invite_id: preparedRow.invite_id });
  assert.equal(retryClaim.error, null, retryClaim.error?.message);
  const retryEnsure = await holder.client.rpc('ensure_registration_contact_for_user', {
    p_user_id: holder.userId, p_organization_id: fx.org.id,
  });
  assert.equal(retryEnsure.error, null, retryEnsure.error?.message);
  assert.equal(retryEnsure.data, identity.contact.id);

  const after = await fx.ownershipSnapshot(identity);
  assert.equal(after.contact.user_id, holder.userId);
  assert.equal(after.ticket.owner_user_id, holder.userId);
});

test('cenario 3: CPF ja vinculado a outro user_id continua conflito e nao transfere', async () => {
  const identity = await fx.createImportedIdentity('ocupado');
  const owner = await fx.makeAuthUser('dono-ocupado', generateValidCpf());
  await fx.must(fx.service.from('registration_contacts').update({ user_id: owner.userId }).eq('id', identity.contact.id), 'prelink contact');

  const stranger = await fx.makeAuthUser('estranho-ocupado', identity.cpf);
  const ensure = await stranger.client.rpc('ensure_registration_contact_for_user', {
    p_user_id: stranger.userId, p_organization_id: fx.org.id,
  });
  assert.ok(ensure.error);
  assert.equal(ensure.error.message, 'CPF_ALREADY_LINKED_TO_ANOTHER_USER');

  const after = await fx.ownershipSnapshot(identity);
  assert.equal(after.contact.user_id, owner.userId);
  assert.equal(after.ticket.owner_user_id, owner.userId);
});

test('LEGITIMO 4: signup de CPF novo materializa cadastro proprio', async () => {
  const newbie = await fx.makeAuthUser('pessoa-nova');
  const conflict = await newbie.client.rpc('find_conflicting_registration_contact', {
    p_cpf: newbie.cpf, p_exclude_user_id: newbie.userId, p_organization_id: fx.org.id,
  });
  const conflictRow = Array.isArray(conflict.data) ? conflict.data[0] : conflict.data;
  assert.equal(conflictRow.has_conflict, false);

  const ensure = await newbie.client.rpc('ensure_registration_contact_for_user', {
    p_user_id: newbie.userId, p_organization_id: fx.org.id,
  });
  assert.equal(ensure.error, null, ensure.error?.message);
  assert.ok(ensure.data);
  const created = await fx.must(
    fx.service.from('registration_contacts').select('id,user_id,cpf').eq('id', ensure.data).single(),
    'new contact',
  );
  assert.equal(created.user_id, newbie.userId);
  assert.equal(created.cpf, newbie.cpf);
});

test('concorrencia: dois atacantes sem invite nao assumem o mesmo cadastro', async () => {
  const identity = await fx.createImportedIdentity('corrida');
  const a = await fx.makeAuthUser('corrida-a', identity.cpf);
  const b = await fx.makeAuthUser('corrida-b', identity.cpf);

  const [first, second] = await Promise.all([
    a.client.rpc('ensure_registration_contact_for_user', { p_user_id: a.userId, p_organization_id: fx.org.id }),
    b.client.rpc('ensure_registration_contact_for_user', { p_user_id: b.userId, p_organization_id: fx.org.id }),
  ]);
  assert.ok(first.error);
  assert.ok(second.error);

  const after = await fx.ownershipSnapshot(identity);
  assert.equal(after.contact.user_id, null);
  assert.equal(after.participant.user_id, null);
  assert.equal(after.ticket.owner_user_id, null);
});

test('ATTACK B: authenticated nao executa link_participant_account_projection', async () => {
  const identity = await fx.createImportedIdentity('rpc-link');
  const attacker = await fx.makeAuthUser('atacante-rpc');
  const result = await attacker.client.rpc('link_participant_account_projection', {
    p_participant_id: identity.participant.id,
  });
  assert.ok(result.error, 'authenticated nao pode executar a RPC');
  const after = await fx.ownershipSnapshot(identity);
  assert.equal(after.contact.user_id, null);
  assert.equal(after.participant.user_id, null);
  assert.equal(after.ticket.owner_user_id, null);
});

test('ATTACK D: reconcile_registration_contact_account nao anexa contact orfao arbitrario', async () => {
  const identity = await fx.createImportedIdentity('rpc-reconcile');
  const attacker = await fx.makeAuthUser('atacante-reconcile');
  const before = await fx.ownershipSnapshot(identity);

  const result = await attacker.client.rpc('reconcile_registration_contact_account', {
    p_registration_contact_id: identity.contact.id,
    p_user_id: attacker.userId,
  });
  assert.ok(result.error, 'authenticated nao pode reconciliar contact orfao de terceiro');

  const after = await fx.ownershipSnapshot(identity);
  assert.equal(after.contact.user_id, before.contact.user_id);
  assert.equal(after.contact.user_id, null);
  assert.equal(after.participant.user_id, before.participant.user_id);
  assert.equal(after.participant.user_id, null);
  assert.equal(after.ticket.owner_user_id, before.ticket.owner_user_id);
  assert.equal(after.ticket.owner_user_id, null);
});

test('ATTACK E: ensure_order_for_participant nao anexa participant orfao arbitrario', async () => {
  const identity = await fx.createImportedIdentity('rpc-ensure-order');
  const attacker = await fx.makeAuthUser('atacante-ensure-order');
  const before = await fx.ownershipSnapshot(identity);

  const result = await attacker.client.rpc('ensure_order_for_participant', {
    p_participant_id: identity.participant.id,
    p_user_id: attacker.userId,
  });
  assert.ok(result.error, 'authenticated nao pode garantir pedido anexando participant de terceiro');

  const after = await fx.ownershipSnapshot(identity);
  assert.equal(after.contact.user_id, before.contact.user_id);
  assert.equal(after.contact.user_id, null);
  assert.equal(after.participant.user_id, before.participant.user_id);
  assert.equal(after.participant.user_id, null);
  assert.equal(after.ticket.owner_user_id, before.ticket.owner_user_id);
  assert.equal(after.ticket.owner_user_id, null);
});

test('ATTACK C / SELF / LEGIT 4 admin: get_customer_profile respeita self e RBAC', async () => {
  const admin = await fx.makeAdmin('admin-profile');
  const userA = await fx.makeAuthUser('perfil-a');
  const userB = await fx.makeAuthUser('perfil-b');
  await fx.must(fx.service.from('participants').insert({
    organization_id: fx.org.id, event_id: fx.event.id, user_id: userB.userId,
    full_name: 'perfil-b', cpf: userB.cpf, email: userB.email, registration_status: 'confirmed',
  }), 'participant B for admin scope');

  const self = await userA.client.rpc('get_customer_profile', { p_user_id: userA.userId });
  assert.equal(self.error, null, self.error?.message);
  const selfRow = Array.isArray(self.data) ? self.data[0] : self.data;
  assert.equal(selfRow.user_id, userA.userId);
  assert.equal(selfRow.cpf, userA.cpf);

  const idor = await userA.client.rpc('get_customer_profile', { p_user_id: userB.userId });
  assert.equal(idor.error, null, idor.error?.message);
  const idorRows = Array.isArray(idor.data) ? idor.data : (idor.data ? [idor.data] : []);
  assert.equal(idorRows.length, 0, 'User A nao pode ler PII de User B');

  const adminRead = await admin.client.rpc('get_customer_profile', { p_user_id: userB.userId });
  assert.equal(adminRead.error, null, adminRead.error?.message);
  const adminRow = Array.isArray(adminRead.data) ? adminRead.data[0] : adminRead.data;
  assert.equal(adminRow?.user_id, userB.userId);
  assert.equal(adminRow?.cpf, userB.cpf);
});
