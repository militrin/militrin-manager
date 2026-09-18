// Leila-like: Cadastro unlinked + Auth confirmada do mesmo e-mail,
// mesmo CPF, convite pending com auth_user_id null.
// Familiar negativo: Cadastro B, CPF diferente, mesmo e-mail da Auth de A.
// Roda contra Supabase local. Nao toca producao.
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
    for (const n of nums) {
      sum += n * weight;
      weight -= 1;
    }
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
  const localUrl = String(local.NEXT_PUBLIC_SUPABASE_URL ?? '').replace(/\/$/, '');
  const candidates = [];
  if (/127\.0\.0\.1|localhost/.test(localUrl)) candidates.push(localUrl);
  candidates.push('http://127.0.0.1:15421', 'http://127.0.0.1:54321');
  return {
    urlCandidates: [...new Set(candidates)],
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    serviceKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU',
  };
}

async function ping(url) {
  try {
    const response = await fetch(`${url}/auth/v1/health`);
    return response.ok;
  } catch {
    return false;
  }
}

const env = await environment();
let availableUrl = null;
for (const url of env.urlCandidates) {
  if (url && await ping(url)) {
    availableUrl = url;
    break;
  }
}

if (!availableUrl) {
  test('first-access existing-auth: supabase local ausente, pula integracao', () => {
    assert.ok(true);
  });
} else {
  const service = createClient(availableUrl, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const password = 'SenhaForte!123';

  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }

  async function clientFor(email) {
    const client = createClient(availableUrl, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`login ${email}: ${signIn.error.message}`);
    return client;
  }

  const org = await must(service.from('organizations').insert({
    name: 'Leila First Access', slug: `leila-fa-${suffix}`,
  }).select('id').single(), 'org');
  const event = await must(service.from('events').insert({
    organization_id: org.id, name: 'Evento Leila FA', year: 2026, slug: `leila-fa-evt-${suffix}`,
    is_active: true, registration_enabled: true, starts_at: '2026-11-21T12:00:00-03:00', min_age: 0,
  }).select('id').single(), 'event');
  const category = await must(service.from('ticket_categories').insert({
    event_id: event.id, name: 'Geral', slug: `leila-fa-geral-${suffix}`, is_active: true,
  }).select('id').single(), 'category');
  const batch = await must(service.from('registration_batches').insert({
    event_id: event.id, name: 'Lote', sequence_number: 1, male_price: 100, female_price: 100,
    max_confirmed_registrations: 100, is_active: true,
  }).select('id').single(), 'batch');

  async function makeAdmin(label) {
    const email = `leila-admin-${label}-${suffix}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `admin ${label}`);
    await must(service.from('customer_profiles').upsert({
      user_id: created.user.id, cpf: generateValidCpf(), full_name: label, birth_date: '1990-05-05',
      phone: '11999990001', city: 'Itapiranga', gender: 'male',
    }, { onConflict: 'user_id' }), `${label} profile`);
    const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
    await must(service.from('organization_members').insert({
      organization_id: org.id, user_id: created.user.id, is_owner: true, is_active: true,
    }), `${label} member`);
    await must(service.from('admin_users').insert({
      user_id: created.user.id, role_id: ownerRole.id, is_active: true,
    }), `${label} admin_users`);
    return { client: await clientFor(email), userId: created.user.id, email };
  }

  async function createImportedIdentity(label, email, cpf) {
    const contact = await must(service.from('registration_contacts').insert({
      organization_id: org.id, full_name: label, cpf, birth_date: '1988-03-15',
      gender: 'female', phone: '11988887777', email, city: 'Itapiranga',
    }).select('id,user_id').single(), `contact ${label}`);
    const participant = await must(service.from('participants').insert({
      organization_id: org.id, event_id: event.id, registration_contact_id: contact.id,
      full_name: label, cpf, email, birth_date: '1988-03-15', gender: 'female',
      phone: '11988887777', city: 'Itapiranga', registration_status: 'confirmed',
    }).select('id,user_id').single(), `participant ${label}`);
    const order = await must(service.from('orders').insert({
      organization_id: org.id, event_id: event.id, participant_id: participant.id,
      order_number: `LFA-${label}-${suffix}-${Math.floor(Math.random() * 100000)}`,
      status: 'confirmed', base_amount: 100, final_amount: 100, buyer_type: 'administrative',
    }).select('id,user_id').single(), `order ${label}`);
    const item = await must(service.from('order_items').insert({
      order_id: order.id, event_id: event.id, participant_id: participant.id,
      registration_contact_id: contact.id, item_kind: 'ticket', ticket_category_id: category.id,
      batch_id: batch.id, quantity: 1, unit_price: 100, discount_amount: 0, final_amount: 100,
      status: 'confirmed', ownership_status: 'assigned', holder_full_name: label,
      intended_owner_contact_id: contact.id,
    }).select('id').single(), `item ${label}`);
    const ticket = await must(service.from('tickets').insert({
      order_id: order.id, order_item_id: item.id, participant_id: participant.id,
      event_id: event.id, organization_id: org.id, status: 'active',
      intended_owner_contact_id: contact.id,
    }).select('id,owner_user_id,participant_id,intended_owner_contact_id').single(), `ticket ${label}`);
    await must(service.from('participation_history').insert({
      event_id: event.id, participant_id: participant.id, registration_contact_id: contact.id,
      event_year: 2026, full_name: label, cpf, email, status: 'confirmed', source: 'import',
    }), `history ${label}`);
    return { contact, participant, order, item, ticket, cpf, email };
  }

  const admin = await makeAdmin('owner');

  await test('Leila-like e familiar compartilhado', { concurrency: false }, async (t) => {
    await t.test('Leila-like: Auth confirmada da mesma pessoa conclui o vinculo sem criar Auth nova nem transferir ingresso', async () => {
    const email = `leila-like-${suffix}@qa.local`;
    const cpf = generateValidCpf();
    const identity = await createImportedIdentity('Leila Like', email, cpf);
    const created = await must(service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    }), 'leila auth');
    const authUserId = created.user.id;
    await must(service.from('customer_profiles').upsert({
      user_id: authUserId,
      account_status: 'pending_activation',
      must_change_password: true,
      must_complete_profile: true,
    }, { onConflict: 'user_id' }), 'leila profile');

    const prepared = await must(admin.client.rpc('prepare_registration_contact_account_invite', {
      p_registration_contact_id: identity.contact.id,
    }), 'prepare leila invite');
    const preparedRow = Array.isArray(prepared) ? prepared[0] : prepared;
    const inviteId = preparedRow.invite_id;
    assert.ok(inviteId);

    await must(service.from('participant_account_invites').update({
      auth_user_id: null,
      requires_password_setup: true,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }).eq('id', inviteId), 'leave auth_user_id null');
    await must(service.auth.admin.updateUserById(authUserId, {
      user_metadata: { participant_invite_id: inviteId },
    }), 'stamp metadata');

    const health = await admin.client.rpc('get_account_health_case', {
      p_case_id: identity.contact.id,
      p_organization_id: org.id,
    });
    if (!health.error) {
      assert.equal(health.data?.case?.state, 'confirmed_unlinked');
      assert.ok(health.data.case.available_actions.includes('send_access'));
    }

    const beforeConflict = await admin.client.rpc('find_conflicting_registration_contact', {
      p_cpf: cpf,
      p_exclude_user_id: authUserId,
      p_organization_id: org.id,
    });
    const beforeRow = Array.isArray(beforeConflict.data) ? beforeConflict.data[0] : beforeConflict.data;
    assert.equal(beforeConflict.error, null, beforeConflict.error?.message);
    assert.equal(beforeRow.has_conflict, false, 'o proprio Cadastro autorizado pelo convite nao e outra conta');

    const ticketBefore = await must(service.from('tickets').select('id,owner_user_id,participant_id,intended_owner_contact_id').eq('id', identity.ticket.id).single(), 'ticket before');
    const orderBefore = await must(service.from('orders').select('id,user_id').eq('id', identity.order.id).single(), 'order before');
    const holderBefore = await must(service.from('order_items').select('id,holder_full_name,participant_id').eq('id', identity.item.id).single(), 'holder before');

    const guest = await clientFor(email);
    const session = await guest.auth.getUser();
    assert.equal(session.data.user?.id, authUserId);

    await must(guest.rpc('upsert_customer_profile', {
      p_user_id: authUserId,
      p_full_name: 'Leila Like',
      p_cpf: cpf,
      p_birth_date: '1988-03-15',
      p_gender: 'female',
      p_phone: '11988887777',
      p_city: 'Itapiranga',
    }), 'upsert profile');

    const claimed = await must(guest.rpc('claim_registration_contact_account_invite', {
      p_invite_id: inviteId,
    }), 'claim');
    assert.equal(String(claimed), String(identity.contact.id));
    await must(guest.rpc('ensure_registration_contact_for_user', { p_user_id: authUserId }), 'ensure');

    const contactAfter = await must(service.from('registration_contacts').select('id,user_id').eq('id', identity.contact.id).single(), 'contact after');
    const participantAfter = await must(service.from('participants').select('id,user_id').eq('id', identity.participant.id).single(), 'participant after');
    const ticketAfter = await must(service.from('tickets').select('id,owner_user_id,participant_id,intended_owner_contact_id').eq('id', identity.ticket.id).single(), 'ticket after');
    const orderAfter = await must(service.from('orders').select('id,user_id').eq('id', identity.order.id).single(), 'order after');
    const holderAfter = await must(service.from('order_items').select('id,holder_full_name,participant_id').eq('id', identity.item.id).single(), 'holder after');
    const inviteAfter = await must(service.from('participant_account_invites').select('status,auth_user_id,claimed_user_id').eq('id', inviteId).single(), 'invite after');

    assert.equal(contactAfter.user_id, authUserId, 'MESMO auth.users.id');
    assert.equal(participantAfter.user_id, authUserId);
    assert.equal(ticketAfter.id, ticketBefore.id);
    assert.equal(ticketAfter.participant_id, ticketBefore.participant_id);
    assert.equal(ticketAfter.intended_owner_contact_id, ticketBefore.intended_owner_contact_id);
    assert.equal(ticketAfter.owner_user_id, ticketBefore.owner_user_id, 'ativacao de conta nao preenche owner_user_id');
    assert.equal(orderAfter.id, orderBefore.id);
    assert.ok(orderAfter.user_id == null || orderAfter.user_id === authUserId);
    assert.equal(holderAfter.holder_full_name, holderBefore.holder_full_name);
    assert.equal(holderAfter.participant_id, holderBefore.participant_id);
    assert.equal(inviteAfter.status, 'claimed');
    assert.equal(inviteAfter.claimed_user_id, authUserId);
    assert.equal(inviteAfter.auth_user_id, authUserId);

    const listed = await must(service.rpc('find_auth_email_confirmation_status', { p_email: email }), 'auth by email');
    const sameEmail = Array.isArray(listed) ? listed : listed ? [listed] : [];
    assert.equal(sameEmail.length, 1);
    assert.equal(sameEmail[0].user_id, authUserId);

    if (!health.error) {
      const afterHealth = await admin.client.rpc('get_account_health_case', {
        p_case_id: identity.contact.id,
        p_organization_id: org.id,
      });
      assert.equal(afterHealth.data?.case?.state, 'healthy');
    }
  });

    await t.test('familiar negativo: mesmo e-mail da Auth de A nao vincula Cadastro B de outro CPF', async () => {
    const sharedEmail = `family-shared-${suffix}@qa.local`;
    const cpfA = generateValidCpf();
    const cpfB = generateValidCpf();
    assert.notEqual(cpfA, cpfB);
    const personA = await createImportedIdentity('Familiar A', sharedEmail, cpfA);
    const personB = await createImportedIdentity('Familiar B', sharedEmail, cpfB);
    const created = await must(service.auth.admin.createUser({
      email: sharedEmail,
      password,
      email_confirm: true,
    }), 'family auth A');
    await must(service.from('registration_contacts').update({ user_id: created.user.id }).eq('id', personA.contact.id), 'link A');
    await must(service.from('participants').update({ user_id: created.user.id }).eq('id', personA.participant.id), 'link A participant');
    await must(service.from('tickets').update({ owner_user_id: created.user.id }).eq('id', personA.ticket.id), 'link A ticket');

    const eligibilityB = await admin.client.rpc('check_registration_contact_account_invite_eligibility', {
      p_registration_contact_id: personB.contact.id,
    });
    const eligibilityRow = Array.isArray(eligibilityB.data) ? eligibilityB.data[0] : eligibilityB.data;
    assert.equal(eligibilityB.error, null, eligibilityB.error?.message);
    assert.equal(eligibilityRow.eligible, false, 'Enviar acesso de B deve ser bloqueado');
    assert.match(String(eligibilityRow.reason_code), /email_conflict|account_attention|shared_email/);

    const prepareB = await admin.client.rpc('prepare_registration_contact_account_invite', {
      p_registration_contact_id: personB.contact.id,
    });
    assert.ok(prepareB.error, 'prepare de B nao pode criar convite');

    const inviteB = await must(service.from('participant_account_invites').insert({
      organization_id: org.id,
      registration_contact_id: personB.contact.id,
      email: sharedEmail,
      status: 'pending',
      invited_by: admin.userId,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      requires_password_setup: true,
    }).select('id').single(), 'crafted B invite');
    await must(service.auth.admin.updateUserById(created.user.id, {
      user_metadata: { participant_invite_id: 'not-b-invite' },
    }), 'metadata stays on A');

    const guestA = await clientFor(sharedEmail);
    const conflictB = await guestA.rpc('find_conflicting_registration_contact', {
      p_cpf: cpfB,
      p_exclude_user_id: created.user.id,
      p_organization_id: org.id,
    });
    const conflictRow = Array.isArray(conflictB.data) ? conflictB.data[0] : conflictB.data;
    assert.equal(conflictRow.has_conflict, true, 'CPF de B continua protegido contra a Auth de A');

    const claimB = await guestA.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteB.id });
    assert.ok(claimB.error, 'claim de B pela Auth de A deve falhar');

    const contactB = await must(service.from('registration_contacts').select('user_id').eq('id', personB.contact.id).single(), 'B still unlinked');
    const ticketB = await must(service.from('tickets').select('owner_user_id,intended_owner_contact_id').eq('id', personB.ticket.id).single(), 'B ticket');
    const ticketA = await must(service.from('tickets').select('owner_user_id,intended_owner_contact_id').eq('id', personA.ticket.id).single(), 'A ticket');
    assert.equal(contactB.user_id, null);
    assert.equal(ticketB.owner_user_id, null);
    assert.equal(ticketB.intended_owner_contact_id, personB.contact.id);
    assert.equal(ticketA.owner_user_id, created.user.id);
    assert.equal(ticketA.intended_owner_contact_id, personA.contact.id);

    await must(service.from('customer_profiles').upsert({
      user_id: created.user.id, full_name: 'Familiar A', cpf: cpfA,
      birth_date: '1988-03-15', phone: '11988887777', city: 'Itapiranga', gender: 'female',
    }, { onConflict: 'user_id' }), 'family A profile');
    await must(service.auth.admin.updateUserById(created.user.id, {
      user_metadata: { participant_invite_id: inviteB.id },
    }), 'tamper metadata to B invite');
    const claimTampered = await guestA.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteB.id });
    assert.ok(claimTampered.error, 'metadata de B na Auth de A nao autoriza claim de B');
    const conflictCpfB = await guestA.rpc('find_conflicting_registration_contact', {
      p_cpf: cpfB,
      p_exclude_user_id: created.user.id,
      p_organization_id: org.id,
    });
    const conflictCpfRow = Array.isArray(conflictCpfB.data) ? conflictCpfB.data[0] : conflictCpfB.data;
    assert.equal(conflictCpfRow.has_conflict, true, 'CPF de B permanece conflito mesmo com metadata adulterada');
    const contactBAfterTamper = await must(service.from('registration_contacts').select('user_id').eq('id', personB.contact.id).single(), 'B still unlinked after tamper');
    const ticketBAfterTamper = await must(service.from('tickets').select('owner_user_id').eq('id', personB.ticket.id).single(), 'B ticket after tamper');
    assert.equal(contactBAfterTamper.user_id, null);
    assert.equal(ticketBAfterTamper.owner_user_id, null);

    const healthB = await admin.client.rpc('get_account_health_case', {
      p_case_id: personB.contact.id,
      p_organization_id: org.id,
    });
    if (!healthB.error) {
      assert.notEqual(healthB.data?.case?.state, 'confirmed_unlinked');
      assert.match(String(healthB.data?.case?.state ?? ''), /attention|reviewed/);
    }
    });

    await t.test('ownership: materializa so intended do Cadastro reivindicado e nunca substitui owner preenchido', async () => {
      const email = `own-mat-${suffix}@qa.local`;
      const identity = await createImportedIdentity('Owner Mat', email, generateValidCpf());
      const other = await createImportedIdentity('Owner Other', `own-other-${suffix}@qa.local`, generateValidCpf());
      const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), 'owner mat auth');
      const decoy = await must(service.auth.admin.createUser({
        email: `own-decoy-${suffix}@qa.local`, password, email_confirm: true,
      }), 'decoy auth');
      await must(service.from('tickets').update({ owner_user_id: decoy.user.id }).eq('id', identity.ticket.id), 'prefill owner');
      const otherTicket = other.ticket;

      const prepared = await must(admin.client.rpc('prepare_registration_contact_account_invite', {
        p_registration_contact_id: identity.contact.id,
      }), 'prepare owner mat');
      const inviteId = (Array.isArray(prepared) ? prepared[0] : prepared).invite_id;
      await must(service.from('participant_account_invites').update({
        auth_user_id: null,
        requires_password_setup: true,
        expires_at: new Date(Date.now() + 86400000 * 7).toISOString(),
      }).eq('id', inviteId), 'null auth_user_id');
      await must(service.auth.admin.updateUserById(created.user.id, {
        user_metadata: { participant_invite_id: inviteId },
      }), 'metadata owner mat');
      await must(service.from('customer_profiles').upsert({
        user_id: created.user.id, full_name: 'Owner Mat', cpf: identity.cpf,
        birth_date: '1988-03-15', phone: '11988887777', city: 'Itapiranga', gender: 'female',
      }, { onConflict: 'user_id' }), 'profile owner mat');

      const guest = await clientFor(email);
      await must(guest.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteId }), 'claim owner mat');

      const kept = await must(service.from('tickets').select('owner_user_id,intended_owner_contact_id').eq('id', identity.ticket.id).single(), 'kept filled owner');
      const untouched = await must(service.from('tickets').select('owner_user_id,intended_owner_contact_id').eq('id', otherTicket.id).single(), 'other intended');
      assert.equal(kept.owner_user_id, decoy.user.id, 'owner preenchido nunca e substituido');
      assert.equal(kept.intended_owner_contact_id, identity.contact.id);
      assert.equal(untouched.owner_user_id, null, 'intended de outro Cadastro nao materializa');
      assert.equal(untouched.intended_owner_contact_id, other.contact.id);
    });

    await t.test('metadata/invite negativos nao autorizam claim', async () => {
      const email = `neg-${suffix}@qa.local`;
      const identity = await createImportedIdentity('Negativa', email, generateValidCpf());
      const other = await createImportedIdentity('Outra Pessoa', `neg-other-${suffix}@qa.local`, generateValidCpf());
      const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), 'neg auth');
      const otherAuth = await must(service.auth.admin.createUser({
        email: `neg-auth2-${suffix}@qa.local`, password, email_confirm: true,
      }), 'other auth');
      const prepared = await must(admin.client.rpc('prepare_registration_contact_account_invite', {
        p_registration_contact_id: identity.contact.id,
      }), 'prepare neg');
      const inviteId = (Array.isArray(prepared) ? prepared[0] : prepared).invite_id;
      const otherPrepared = await must(admin.client.rpc('prepare_registration_contact_account_invite', {
        p_registration_contact_id: other.contact.id,
      }), 'prepare other invite');
      const otherInviteId = (Array.isArray(otherPrepared) ? otherPrepared[0] : otherPrepared).invite_id;
      await must(service.from('participant_account_invites').update({
        auth_user_id: null,
        expires_at: new Date(Date.now() + 86400000 * 7).toISOString(),
      }).eq('id', inviteId).select('id,auth_user_id').maybeSingle(), 'pending null');
      const guest = await clientFor(email);
      const inviteBefore = await must(service.from('participant_account_invites').select('id,auth_user_id,status').eq('id', inviteId).single(), 'invite before negatives');
      assert.equal(inviteBefore.auth_user_id, null);
      assert.equal(inviteBefore.status, 'pending');

      await must(service.auth.admin.updateUserById(created.user.id, { user_metadata: { participant_invite_id: null } }), 'no metadata');
      let claim = await guest.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteId });
      assert.ok(claim.error, 'metadata ausente');

      await must(service.auth.admin.updateUserById(created.user.id, {
        user_metadata: { participant_invite_id: '00000000-0000-4000-8000-000000000099' },
      }), 'tampered metadata');
      claim = await guest.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteId });
      assert.ok(claim.error, 'metadata adulterada');

      await must(service.auth.admin.updateUserById(created.user.id, {
        user_metadata: { participant_invite_id: otherInviteId },
      }), 'other person invite metadata');
      claim = await guest.rpc('claim_registration_contact_account_invite', { p_invite_id: otherInviteId });
      assert.ok(claim.error, 'invite de outra pessoa');

      const otherOrg = await must(service.from('organizations').insert({
        name: 'Outra Org Neg', slug: `neg-org-${suffix}`,
      }).select('id').single(), 'other org');
      const moved = await service.from('participant_account_invites').update({
        organization_id: otherOrg.id,
        auth_user_id: null,
        status: 'pending',
        expires_at: new Date(Date.now() + 86400000 * 7).toISOString(),
      }).eq('id', inviteId);
      assert.ok(moved.error, 'outra org: convite nao pode sair da organizacao da Pessoa');

      await must(service.from('participant_account_invites').update({
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        auth_user_id: null,
      }).eq('id', inviteId), 'expire invite');
      await must(service.auth.admin.updateUserById(created.user.id, {
        user_metadata: { participant_invite_id: inviteId },
      }), 'restore metadata');
      claim = await guest.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteId });
      assert.ok(claim.error, 'invite expirado');

      await must(service.from('participant_account_invites').update({
        status: 'revoked',
        expires_at: new Date(Date.now() + 86400000 * 7).toISOString(),
      }).eq('id', inviteId), 'revoke');
      claim = await guest.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteId });
      assert.ok(claim.error, 'invite cancelled');

      const otherGuest = createClient(availableUrl, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const otherLogin = await otherGuest.auth.signInWithPassword({ email: `neg-auth2-${suffix}@qa.local`, password });
      assert.equal(otherLogin.error, null);
      await must(service.from('participant_account_invites').update({
        status: 'pending',
        auth_user_id: created.user.id,
        expires_at: new Date(Date.now() + 86400000 * 7).toISOString(),
      }).eq('id', inviteId), 'restore pending with auth A');
      claim = await otherGuest.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteId });
      assert.ok(claim.error, 'Auth diferente');

      await must(service.from('participant_account_invites').update({
        status: 'claimed',
        claimed_user_id: otherAuth.user.id,
        auth_user_id: created.user.id,
        expires_at: new Date(Date.now() + 86400000 * 7).toISOString(),
      }).eq('id', inviteId), 'claimed by other');
      claim = await guest.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteId });
      assert.ok(claim.error, 'invite claimed');

      const contactStill = await must(service.from('registration_contacts').select('user_id').eq('id', identity.contact.id).single(), 'still unlinked');
      assert.equal(contactStill.user_id, null);
      void otherAuth;
    });

    await t.test('Ana-like: Auth nao confirmada, link expirado, resend signup, mesma Auth, claim, healthy', async () => {
      const email = `ana-like-${suffix}@qa.local`;
      const identity = await createImportedIdentity('Ana Like', email, generateValidCpf());
      const created = await must(service.auth.admin.createUser({
        email, password, email_confirm: false,
      }), 'ana unconfirmed');
      const authUserId = created.user.id;
      const invite = await must(service.from('participant_account_invites').insert({
        organization_id: org.id,
        registration_contact_id: identity.contact.id,
        email,
        status: 'pending',
        invited_by: admin.userId,
        auth_user_id: authUserId,
        requires_password_setup: true,
        auth_link_expires_at: new Date(Date.now() - 60_000).toISOString(),
        expires_at: new Date(Date.now() + 86400000 * 7).toISOString(),
      }).select('id').single(), 'ana invite');
      const inviteId = invite.id;
      await must(service.auth.admin.updateUserById(authUserId, {
        user_metadata: { participant_invite_id: inviteId },
      }), 'ana metadata');

      const healthBefore = await admin.client.rpc('get_account_health_case', {
        p_case_id: identity.contact.id, p_organization_id: org.id,
      });
      if (!healthBefore.error) {
        assert.equal(healthBefore.data?.case?.state, 'pending_confirmation');
        assert.ok(healthBefore.data.case.available_actions.includes('resend_confirmation'));
      }

      const anon = createClient(availableUrl, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const resend = await anon.auth.resend({
        type: 'signup',
        email,
        options: {
          emailRedirectTo: `http://127.0.0.1:3000/auth/callback?next=${encodeURIComponent(`/primeiro-acesso?invite=${inviteId}&next=%2Fminha-conta%2Fingressos`)}`,
        },
      });
      assert.equal(resend.error, null, resend.error?.message ?? 'resend signup');
      const afterUser = await service.auth.admin.getUserById(authUserId);
      assert.equal(afterUser.data.user?.id, authUserId);
      assert.equal(afterUser.data.user?.email_confirmed_at ?? null, null);
      const listed = await must(service.rpc('find_auth_email_confirmation_status', { p_email: email }), 'ana auth unique');
      const sameEmail = Array.isArray(listed) ? listed : [listed];
      assert.equal(sameEmail.length, 1);
      assert.equal(sameEmail[0].user_id, authUserId);
      const contacts = await must(service.from('registration_contacts').select('id').eq('organization_id', org.id).eq('email', email), 'ana unique contact');
      assert.equal(contacts.length, 1);

      await must(service.auth.admin.updateUserById(authUserId, { email_confirm: true, password }), 'confirm ana');
      await must(service.from('customer_profiles').upsert({
        user_id: authUserId, full_name: 'Ana Like', cpf: identity.cpf,
        birth_date: '1988-03-15', phone: '11988887777', city: 'Itapiranga', gender: 'female',
      }, { onConflict: 'user_id' }), 'ana profile');
      const guest = await clientFor(email);
      const conflict = await guest.rpc('find_conflicting_registration_contact', {
        p_cpf: identity.cpf, p_exclude_user_id: authUserId, p_organization_id: org.id,
      });
      const conflictRow = Array.isArray(conflict.data) ? conflict.data[0] : conflict.data;
      assert.equal(conflictRow.has_conflict, false);
      await must(guest.rpc('claim_registration_contact_account_invite', { p_invite_id: inviteId }), 'ana claim');
      await must(guest.rpc('ensure_registration_contact_for_user', { p_user_id: authUserId }), 'ana ensure');
      const linked = await must(service.from('registration_contacts').select('user_id').eq('id', identity.contact.id).single(), 'ana linked');
      assert.equal(linked.user_id, authUserId);
      if (!healthBefore.error) {
        const healthAfter = await admin.client.rpc('get_account_health_case', {
          p_case_id: identity.contact.id, p_organization_id: org.id,
        });
        assert.equal(healthAfter.data?.case?.state, 'healthy');
      }
    });
  });
}
