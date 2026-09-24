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
  const localUrl = local.NEXT_PUBLIC_SUPABASE_URL ?? '';
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
  test('account-health local supabase ausente: pula integracao', () => {
    assert.ok(true);
  });
} else {
  const service = createClient(availableUrl, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anon = createClient(availableUrl, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
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

  const probe = await service.rpc('list_account_health_cases', {
    p_organization_id: '00000000-0000-0000-0000-000000000001',
    p_state: 'all',
    p_search: null,
    p_limit: 1,
    p_offset: 0,
  });
  if (probe.error && /could not find the function|schema cache|does not exist/i.test(String(probe.error.message))) {
    test('account-health migration local ausente: pula integracao', () => {
      assert.ok(true);
    });
  } else {
    const orgA = await must(service.from('organizations').insert({ name: 'Health A', slug: `health-a-${suffix}` }).select('id').single(), 'orgA');
    const orgB = await must(service.from('organizations').insert({ name: 'Health B', slug: `health-b-${suffix}` }).select('id').single(), 'orgB');

    async function makeRoleAdmin(orgId, label, roleCode) {
      const email = `health-${roleCode}-${label}-${suffix}@qa.local`;
      const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `admin ${label}`);
      await must(service.from('customer_profiles').upsert({
        user_id: created.user.id, cpf: generateValidCpf(), full_name: label, birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male',
      }, { onConflict: 'user_id' }), `${label} profile`);
      const role = await resolveOrCreateAdminRole(service, roleCode, roleCode);
      await must(service.from('organization_members').insert({
        organization_id: orgId,
        user_id: created.user.id,
        is_owner: roleCode === 'owner',
        is_active: true,
      }), `${label} member`);
      await must(service.from('admin_users').insert({ user_id: created.user.id, role_id: role.id, is_active: true }), `${label} admin_users`);
      return { client: await clientFor(email), userId: created.user.id, email };
    }

    async function createContact(admin, orgId, email, fullName = 'Pessoa Saude') {
      const result = await admin.rpc('create_registration_contact', {
        p_organization_id: orgId,
        p_full_name: fullName,
        p_cpf: generateValidCpf(),
        p_birth_date: '1994-04-04',
        p_gender: 'female',
        p_phone: '47999990000',
        p_email: email,
        p_city: 'Itapiranga',
      });
      if (result.error) throw new Error(`create contact: ${JSON.stringify(result.error)}`);
      return String(result.data);
    }

    function rowsOf(payload) {
      return Array.isArray(payload?.rows) ? payload.rows : [];
    }

    const ownerA = await makeRoleAdmin(orgA.id, 'oa', 'owner');
    const ownerB = await makeRoleAdmin(orgB.id, 'ob', 'owner');
    const administratorA = await makeRoleAdmin(orgA.id, 'adm', 'administrator');
    const operationalA = await makeRoleAdmin(orgA.id, 'op', 'operational');
    const kitA = await makeRoleAdmin(orgA.id, 'kit', 'kit_delivery');
    const checkinA = await makeRoleAdmin(orgA.id, 'chk', 'checkin');

    test('anon e autenticado comum nao listam saude de contas', async () => {
      const anonResult = await anon.rpc('list_account_health_cases', { p_organization_id: orgA.id });
      assert.ok(anonResult.error);
      const userEmail = `health-user-${suffix}@qa.local`;
      await must(service.auth.admin.createUser({ email: userEmail, password, email_confirm: true }), 'plain user');
      const user = await clientFor(userEmail);
      const userResult = await user.rpc('list_account_health_cases', { p_organization_id: orgA.id });
      assert.ok(userResult.error);
    });

    test('operacional de kit nao acessa a Central', async () => {
      const result = await operationalA.client.rpc('list_account_health_cases', { p_organization_id: orgA.id });
      assert.ok(result.error, 'operacional nao deve executar list_account_health_cases');
    });

    test('kit e check-in nao acessam; Administrator acessa e nao ve orfa', async () => {
      const kitResult = await kitA.client.rpc('list_account_health_cases', { p_organization_id: orgA.id });
      assert.ok(kitResult.error, 'kit_delivery nao deve executar list_account_health_cases');
      const checkinResult = await checkinA.client.rpc('list_account_health_cases', { p_organization_id: orgA.id });
      assert.ok(checkinResult.error, 'checkin nao deve executar list_account_health_cases');
      const adminResult = await administratorA.client.rpc('list_account_health_cases', {
        p_organization_id: orgA.id, p_state: 'all', p_limit: 25, p_offset: 0,
      });
      assert.equal(adminResult.error, null, adminResult.error?.message);
      assert.equal(adminResult.data?.can_view_orphans, false);
      assert.equal(Number(adminResult.data?.counts?.possible_orphan ?? 0), 0);
      const orphanFilter = await administratorA.client.rpc('list_account_health_cases', {
        p_organization_id: orgA.id, p_state: 'possible_orphan', p_limit: 25, p_offset: 0,
      });
      assert.equal(orphanFilter.error, null, orphanFilter.error?.message);
      assert.equal(rowsOf(orphanFilter.data).some((row) => String(row.case_id).startsWith('orphan-')), false);
    });

    test('A) saudavel / N) consolidado laiz-like', async () => {
      const email = `health-healthy-${suffix}@qa.local`;
      const auth = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), 'healthy auth');
      const contactId = await createContact(ownerA.client, orgA.id, email, 'Pessoa Saudavel');
      await must(service.from('registration_contacts').update({ user_id: auth.user.id }).eq('id', contactId), 'link healthy');
      const listed = await ownerA.client.rpc('list_account_health_cases', {
        p_organization_id: orgA.id, p_state: 'healthy', p_search: 'Pessoa Saudavel', p_limit: 25, p_offset: 0,
      });
      assert.equal(listed.error, null, listed.error?.message);
      const row = rowsOf(listed.data).find((item) => item.registration_contact_id === contactId);
      assert.ok(row);
      assert.equal(row.state, 'healthy');
      const detail = await ownerA.client.rpc('get_account_health_case', { p_case_id: contactId, p_organization_id: orgA.id });
      assert.equal(detail.data?.found, true);
      assert.equal(detail.data.case.state, 'healthy');
      assert.equal(Object.prototype.hasOwnProperty.call(detail.data.case, 'confirmation_token'), false);
    });

    test('B) Cadastro sem conta', async () => {
      const contactId = await createContact(ownerA.client, orgA.id, `health-none-${suffix}@qa.local`, 'Sem Conta');
      const listed = await ownerA.client.rpc('list_account_health_cases', {
        p_organization_id: orgA.id, p_state: 'no_account', p_search: 'Sem Conta', p_limit: 25, p_offset: 0,
      });
      const row = rowsOf(listed.data).find((item) => item.registration_contact_id === contactId);
      assert.equal(row.state, 'no_account');
      assert.ok(row.available_actions.includes('send_invite'));
    });

    test('C) Auth pendente + Cadastro', async () => {
      const email = `health-pending-${suffix}@qa.local`;
      const pendingAuth = await must(service.auth.admin.createUser({ email, password, email_confirm: false }), 'pending auth');
      const contactId = await createContact(ownerA.client, orgA.id, email, 'Pendente');
      const listed = await ownerA.client.rpc('list_account_health_cases', {
        p_organization_id: orgA.id, p_state: 'pending_confirmation', p_search: 'Pendente', p_limit: 25, p_offset: 0,
      });
      const row = rowsOf(listed.data).find((item) => item.registration_contact_id === contactId);
      assert.equal(row.state, 'pending_confirmation');
      assert.ok(row.available_actions.includes('resend_confirmation'));
      assert.equal(row.available_actions.includes('send_invite'), false);

      await must(service.auth.admin.updateUserById(pendingAuth.user.id, { email_confirm: true }), 'confirm pending');
      const reanalyzed = await ownerA.client.rpc('get_account_health_case', {
        p_case_id: contactId, p_organization_id: orgA.id,
      });
      assert.equal(reanalyzed.data?.found, true);
      assert.equal(reanalyzed.data.case.state, 'confirmed_unlinked');
      assert.equal(reanalyzed.data.case.available_actions.includes('resend_confirmation'), false);
      assert.ok(reanalyzed.data.case.available_actions.includes('send_access'));
    });

    test('D) Auth confirmada segura para vinculo', async () => {
      const email = `health-confirmed-${suffix}@qa.local`;
      await must(service.auth.admin.createUser({ email, password, email_confirm: true }), 'confirmed auth');
      const contactId = await createContact(ownerA.client, orgA.id, email, 'Confirmada');
      const listed = await ownerA.client.rpc('list_account_health_cases', {
        p_organization_id: orgA.id, p_state: 'no_account', p_search: 'Confirmada', p_limit: 25, p_offset: 0,
      });
      const row = rowsOf(listed.data).find((item) => item.registration_contact_id === contactId);
      assert.equal(row.state, 'confirmed_unlinked');
      assert.ok(row.available_actions.includes('send_access'));
    });

    test('E) e-mail divergente', async () => {
      const liveEmail = `health-div-live-${suffix}@qa.local`;
      const auth = await must(service.auth.admin.createUser({ email: liveEmail, password, email_confirm: true }), 'div auth');
      const contactId = await createContact(ownerA.client, orgA.id, `health-div-contact-${suffix}@qa.local`, 'Email Divergente');
      await must(service.from('registration_contacts').update({ user_id: auth.user.id }).eq('id', contactId), 'link div');
      const listed = await ownerA.client.rpc('list_account_health_cases', {
        p_organization_id: orgA.id, p_state: 'email_divergent', p_search: 'Email Divergente', p_limit: 25, p_offset: 0,
      });
      const row = rowsOf(listed.data).find((item) => item.registration_contact_id === contactId);
      assert.equal(row.state, 'email_divergent');
      assert.equal(row.reason_code, 'email_mismatch');
    });

    test('G) Auth pendente ocupando e-mail de Cadastro vinculado', async () => {
      const liveEmail = `health-laiz-live-${suffix}@qa.local`;
      const originalEmail = `health-laiz-orig-${suffix}@qa.local`;
      const live = await must(service.auth.admin.createUser({ email: liveEmail, password, email_confirm: true }), 'laiz live');
      await must(service.auth.admin.createUser({ email: originalEmail, password, email_confirm: false }), 'laiz occupying');
      const contactId = await createContact(ownerA.client, orgA.id, originalEmail, 'Laiz Like');
      await must(service.from('registration_contacts').update({ user_id: live.user.id }).eq('id', contactId), 'link laiz-like');
      const listed = await ownerA.client.rpc('list_account_health_cases', {
        p_organization_id: orgA.id, p_state: 'attention', p_search: 'Laiz Like', p_limit: 25, p_offset: 0,
      });
      const row = rowsOf(listed.data).find((item) => item.registration_contact_id === contactId);
      assert.equal(row.state, 'attention');
      assert.equal(row.reason_code, 'occupying_email_auth');
      assert.equal(row.available_actions.includes('resend_confirmation'), false);
    });

    test('H) possivel orfa so para owner; I) cross-org nao vaza', async () => {
      const orphanEmail = `health-orphan-${suffix}@qa.local`;
      const orphan = await must(service.auth.admin.createUser({ email: orphanEmail, password, email_confirm: false }), 'orphan');
      await service.from('customer_profiles').delete().eq('user_id', orphan.user.id);
      const secretName = `Pessoa Secreta ${suffix}`;
      await createContact(ownerB.client, orgB.id, `health-secret-${suffix}@qa.local`, secretName);

      const listedA = await ownerA.client.rpc('list_account_health_cases', {
        p_organization_id: orgA.id, p_state: 'all', p_search: secretName, p_limit: 25, p_offset: 0,
      });
      assert.equal(rowsOf(listedA.data).length, 0);
      const leaked = JSON.stringify(listedA.data ?? {});
      assert.doesNotMatch(leaked, new RegExp(secretName));

      const otherOrg = await ownerA.client.rpc('list_account_health_cases', { p_organization_id: orgB.id });
      const otherRows = rowsOf(otherOrg.data);
      assert.equal(otherRows.some((row) => String(row.display_name || '').includes('Secreta')), false);

      const orphans = await ownerA.client.rpc('list_account_health_cases', {
        p_organization_id: orgA.id, p_state: 'possible_orphan', p_search: orphanEmail, p_limit: 25, p_offset: 0,
      });
      assert.equal(orphans.error, null, orphans.error?.message);
      assert.equal(orphans.data?.can_view_orphans, true);
      assert.ok(rowsOf(orphans.data).some((row) => row.case_id === `orphan-${orphan.user.id}`));

      const foreignCase = await ownerA.client.rpc('get_account_health_case', {
        p_case_id: (await service.from('registration_contacts').select('id').eq('organization_id', orgB.id).eq('full_name', secretName).single()).data.id,
        p_organization_id: orgA.id,
      });
      assert.equal(foreignCase.data?.found, false);
    });

    test('classificacao unica por Cadastro e case_id prefixado sem colisao', async () => {
      const shared = `health-shared-${suffix}@qa.local`;
      const first = await createContact(ownerA.client, orgA.id, shared, 'Compartilhada Um');
      const second = await createContact(ownerA.client, orgA.id, shared, 'Compartilhada Dois');
      const listed = await ownerA.client.rpc('list_account_health_cases', {
        p_organization_id: orgA.id, p_state: 'all', p_search: shared, p_limit: 25, p_offset: 0,
      });
      const matches = rowsOf(listed.data).filter((item) => item.registration_contact_id === first || item.registration_contact_id === second);
      assert.equal(matches.length, 2);
      assert.equal(new Set(matches.map((item) => item.case_id)).size, 2);
      assert.equal(matches.every((item) => item.case_id === item.registration_contact_id), true);
      assert.equal(matches.every((item) => item.shared_email === true), true);
      assert.equal(matches.every((item) => item.state === 'attention'), true);
      assert.equal(matches.some((item) => String(item.case_id).startsWith('auth-')), false);
      assert.equal(matches.some((item) => String(item.case_id).startsWith('orphan-')), false);
    });

    test('L) listagem nao altera tickets/owners', async () => {
      const before = await must(service.from('tickets').select('id,owner_user_id,participant_id,token'), 'tickets before');
      await ownerA.client.rpc('list_account_health_cases', { p_organization_id: orgA.id, p_state: 'all', p_limit: 25, p_offset: 0 });
      const after = await must(service.from('tickets').select('id,owner_user_id,participant_id,token'), 'tickets after');
      assert.deepEqual(after, before);
    });

    const v2Probe = await ownerA.client.rpc('resolve_account_health_keep_without_account', {
      p_case_id: '00000000-0000-0000-0000-000000000000',
      p_organization_id: orgA.id,
    });
    const v2Ready = !(v2Probe.error && /could not find the function|schema cache|does not exist/i.test(String(v2Probe.error.message)));

    if (!v2Ready) {
      test('account-health V2 RPC ausente: pula integracao assistida', () => {
        assert.ok(true);
      });
    } else {
      async function fingerprint(contactId) {
        const contact = await must(service.from('registration_contacts').select('id,user_id,email').eq('id', contactId).single(), 'fp contact');
        const participants = await must(service.from('participants').select('id,user_id,email,registration_contact_id').eq('registration_contact_id', contactId), 'fp participants');
        const tickets = await must(service.from('tickets').select('id,owner_user_id,participant_id,intended_owner_contact_id,status').eq('organization_id', orgA.id), 'fp tickets');
        const orders = await must(service.from('orders').select('id,user_id,status').eq('organization_id', orgA.id), 'fp orders');
        return JSON.stringify({ contact, participants, tickets, orders });
      }

      async function createSharedFamily(label) {
        const email = `health-v2-${label}-${suffix}@qa.local`;
        const ownerAuth = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `${label} auth`);
        const ownerContact = await createContact(ownerA.client, orgA.id, email, `${label} Responsavel`);
        await must(service.from('registration_contacts').update({ user_id: ownerAuth.user.id }).eq('id', ownerContact), `${label} link`);
        const familyContact = await createContact(ownerA.client, orgA.id, email, `${label} Familiar`);
        return { email, ownerAuth, ownerContact, familyContact };
      }

      test('A-H) shared_email keep, overlay, reopen e fingerprint', async () => {
        const family = await createSharedFamily('keep');
        const event = await must(service.from('events').insert({
          organization_id: orgA.id, name: 'Health V2 Keep', year: 2034, slug: `health-v2-keep-${suffix}`,
          is_active: true, registration_enabled: true, starts_at: '2034-10-10T12:00:00Z', min_age: 0,
        }).select('id').single(), 'v2 event');
        const familyRow = await must(service.from('registration_contacts').select('id,full_name,cpf,email,user_id').eq('id', family.familyContact).single(), 'family row');
        const participant = await must(service.from('participants').insert({
          organization_id: orgA.id, event_id: event.id, registration_contact_id: family.familyContact,
          full_name: familyRow.full_name, cpf: familyRow.cpf, email: familyRow.email, registration_status: 'confirmed',
        }).select('id,user_id').single(), 'family participant');
        const order = await must(service.from('orders').insert({
          organization_id: orgA.id, event_id: event.id, participant_id: participant.id,
          order_number: `HV2-${suffix}`, status: 'confirmed', base_amount: 10, final_amount: 10, buyer_type: 'administrative',
        }).select('id,user_id').single(), 'family order');
        const category = await must(service.from('ticket_categories').insert({
          event_id: event.id, name: 'Geral', slug: `hv2-geral-${suffix}`, is_active: true,
        }).select('id').single(), 'category');
        const item = await must(service.from('order_items').insert({
          order_id: order.id, event_id: event.id, participant_id: participant.id,
          registration_contact_id: family.familyContact, item_kind: 'ticket', ticket_category_id: category.id,
          quantity: 1, unit_price: 10, discount_amount: 0, final_amount: 10, status: 'confirmed',
        }).select('id').single(), 'item');
        const ticket = await must(service.from('tickets').insert({
          order_id: order.id, order_item_id: item.id, participant_id: participant.id,
          event_id: event.id, organization_id: orgA.id, status: 'active',
          intended_owner_contact_id: family.familyContact,
        }).select('id,owner_user_id,participant_id,intended_owner_contact_id').single(), 'ticket');

        const listed = await ownerA.client.rpc('list_account_health_cases', {
          p_organization_id: orgA.id, p_state: 'attention', p_search: family.email, p_limit: 25, p_offset: 0,
        });
        const row = rowsOf(listed.data).find((item) => item.registration_contact_id === family.familyContact);
        assert.equal(row.state, 'attention');
        assert.equal(row.reason_code, 'shared_email');
        assert.ok(row.available_actions.includes('keep_without_account'));
        assert.ok(row.available_actions.includes('provide_own_email'));

        const before = await fingerprint(family.familyContact);
        const kept = await ownerA.client.rpc('resolve_account_health_keep_without_account', {
          p_case_id: family.familyContact,
          p_organization_id: orgA.id,
        });
        assert.equal(kept.error, null, kept.error?.message);
        assert.equal(kept.data?.case?.state, 'reviewed_without_account');
        assert.ok(kept.data.case.available_actions.includes('reopen_review'));
        assert.equal(kept.data.case.available_actions.includes('send_invite'), false);
        const after = await fingerprint(family.familyContact);
        assert.equal(after, before);

        const contactAfter = await must(service.from('registration_contacts').select('user_id').eq('id', family.familyContact).single(), 'user_id after');
        const participantAfter = await must(service.from('participants').select('user_id').eq('id', participant.id).single(), 'participant after');
        const ticketAfter = await must(service.from('tickets').select('id,owner_user_id,participant_id,intended_owner_contact_id').eq('id', ticket.id).single(), 'ticket after');
        const orderAfter = await must(service.from('orders').select('id,user_id').eq('id', order.id).single(), 'order after');
        assert.equal(contactAfter.user_id, null);
        assert.equal(participantAfter.user_id, participant.user_id);
        assert.deepEqual(ticketAfter, ticket);
        assert.equal(orderAfter.user_id, order.user_id);

        const reopened = await ownerA.client.rpc('reopen_account_health_resolution', {
          p_case_id: family.familyContact,
          p_organization_id: orgA.id,
        });
        assert.equal(reopened.error, null, reopened.error?.message);
        assert.equal(reopened.data?.case?.state, 'attention');
        assert.equal(reopened.data.case.reason_code, 'shared_email');
      });

      test('I/J/K/L/M) informar e-mail proprio, ocupado, cross-org e convite separado', async () => {
        const family = await createSharedFamily('email');
        const freeEmail = `health-v2-own-${suffix}@qa.local`;
        const occupiedEmail = `health-v2-occ-${suffix}@qa.local`;
        const crossEmail = `health-v2-cross-${suffix}@qa.local`;
        await must(service.auth.admin.createUser({ email: occupiedEmail, password, email_confirm: true }), 'occupied auth');
        await createContact(ownerB.client, orgB.id, crossEmail, 'Pessoa Outra Org');

        const occupied = await ownerA.client.rpc('correct_account_health_email', {
          p_case_id: family.familyContact,
          p_organization_id: orgA.id,
          p_email: occupiedEmail,
          p_email_confirm: occupiedEmail,
        });
        assert.ok(occupied.error, 'e-mail com conta deve ser rejeitado');

        const cross = await ownerA.client.rpc('correct_account_health_email', {
          p_case_id: family.familyContact,
          p_organization_id: orgA.id,
          p_email: crossEmail,
          p_email_confirm: crossEmail,
        });
        assert.ok(cross.error, 'e-mail de outra org deve ser rejeitado');
        assert.match(String(cross.error.message), /Nao foi possivel usar este e-mail/i);

        const same = await ownerA.client.rpc('correct_account_health_email', {
          p_case_id: family.familyContact,
          p_organization_id: orgA.id,
          p_email: family.email,
          p_email_confirm: family.email,
        });
        assert.ok(same.error);

        const corrected = await ownerA.client.rpc('correct_account_health_email', {
          p_case_id: family.familyContact,
          p_organization_id: orgA.id,
          p_email: freeEmail,
          p_email_confirm: freeEmail,
        });
        assert.equal(corrected.error, null, corrected.error?.message);
        assert.equal(corrected.data?.case?.state, 'no_account');
        assert.ok(corrected.data.case.available_actions.includes('send_invite'));
        const contact = await must(service.from('registration_contacts').select('email,user_id').eq('id', family.familyContact).single(), 'email after');
        assert.equal(contact.email, freeEmail);
        assert.equal(contact.user_id, null);
      });

      test('N) occupying_email_auth nao recebe keep/provide_own_email', async () => {
        const liveEmail = `health-v2-occ-live-${suffix}@qa.local`;
        const cadastroEmail = `health-v2-occ-cad-${suffix}@qa.local`;
        const live = await must(service.auth.admin.createUser({ email: liveEmail, password, email_confirm: true }), 'occ live');
        await must(service.auth.admin.createUser({ email: cadastroEmail, password, email_confirm: false }), 'occ occupying');
        const contactId = await createContact(ownerA.client, orgA.id, cadastroEmail, 'Ocupante V2');
        await must(service.from('registration_contacts').update({ user_id: live.user.id }).eq('id', contactId), 'link occupying');
        const detail = await ownerA.client.rpc('get_account_health_case', { p_case_id: contactId, p_organization_id: orgA.id });
        assert.equal(detail.data?.case?.reason_code, 'occupying_email_auth');
        assert.ok(detail.data.case.available_actions.includes('review_identity'));
        assert.equal(detail.data.case.available_actions.includes('keep_without_account'), false);
        assert.equal(detail.data.case.available_actions.includes('provide_own_email'), false);
        assert.equal(detail.data.case.available_actions.includes('send_invite'), false);
        assert.equal(detail.data.case.available_actions.includes('send_access'), false);
        assert.ok(detail.data.identity_conflict);
        const keep = await ownerA.client.rpc('resolve_account_health_keep_without_account', {
          p_case_id: contactId,
          p_organization_id: orgA.id,
        });
        assert.ok(keep.error);
      });

      test('O) operacional nao resolve; administrator resolve', async () => {
        const family = await createSharedFamily('perm');
        const denied = await operationalA.client.rpc('resolve_account_health_keep_without_account', {
          p_case_id: family.familyContact,
          p_organization_id: orgA.id,
        });
        assert.ok(denied.error, 'operacional nao deve resolver');
        const allowed = await administratorA.client.rpc('resolve_account_health_keep_without_account', {
          p_case_id: family.familyContact,
          p_organization_id: orgA.id,
        });
        assert.equal(allowed.error, null, allowed.error?.message);
        assert.equal(allowed.data?.case?.state, 'reviewed_without_account');
      });

      test('participant.email acompanha quando igual e preserva quando diverge', async () => {
        const aligned = await createSharedFamily('align');
        const preserved = await createSharedFamily('preserve');
        const event = await must(service.from('events').insert({
          organization_id: orgA.id, name: 'Health V2 Email Align', year: 2034, slug: `health-v2-align-${suffix}`,
          is_active: true, registration_enabled: true, starts_at: '2034-10-11T12:00:00Z', min_age: 0,
        }).select('id').single(), 'align event');

        const alignedRow = await must(service.from('registration_contacts').select('full_name,cpf,email,user_id').eq('id', aligned.familyContact).single(), 'aligned contact');
        const preservedRow = await must(service.from('registration_contacts').select('full_name,cpf,email,user_id').eq('id', preserved.familyContact).single(), 'preserved contact');
        const alignedParticipant = await must(service.from('participants').insert({
          organization_id: orgA.id, event_id: event.id, registration_contact_id: aligned.familyContact,
          full_name: alignedRow.full_name, cpf: alignedRow.cpf, email: alignedRow.email, registration_status: 'confirmed',
        }).select('id,email,user_id').single(), 'aligned participant');
        const preservedParticipant = await must(service.from('participants').insert({
          organization_id: orgA.id, event_id: event.id, registration_contact_id: preserved.familyContact,
          full_name: preservedRow.full_name, cpf: preservedRow.cpf, email: 'ja-divergente@qa.local', registration_status: 'confirmed',
        }).select('id,email,user_id').single(), 'preserved participant');

        const alignedEmail = `health-v2-aligned-own-${suffix}@qa.local`;
        const preservedEmail = `health-v2-preserved-own-${suffix}@qa.local`;
        const alignedResult = await ownerA.client.rpc('correct_account_health_email', {
          p_case_id: aligned.familyContact, p_organization_id: orgA.id, p_email: alignedEmail, p_email_confirm: alignedEmail,
        });
        const preservedResult = await ownerA.client.rpc('correct_account_health_email', {
          p_case_id: preserved.familyContact, p_organization_id: orgA.id, p_email: preservedEmail, p_email_confirm: preservedEmail,
        });
        assert.equal(alignedResult.error, null, alignedResult.error?.message);
        assert.equal(preservedResult.error, null, preservedResult.error?.message);
        assert.equal(alignedResult.data?.last_email_correction?.old_email, aligned.email);
        assert.equal(alignedResult.data?.last_email_correction?.new_email, alignedEmail);

        const alignedAfter = await must(service.from('participants').select('email,user_id').eq('id', alignedParticipant.id).single(), 'aligned after');
        const preservedAfter = await must(service.from('participants').select('email,user_id').eq('id', preservedParticipant.id).single(), 'preserved after');
        assert.equal(alignedAfter.email, alignedEmail);
        assert.equal(alignedAfter.user_id, alignedParticipant.user_id);
        assert.equal(preservedAfter.email, 'ja-divergente@qa.local');
        assert.equal(preservedAfter.user_id, preservedParticipant.user_id);
      });

      test('resolucao keep fica stale apos mudanca estrutural do e-mail', async () => {
        const family = await createSharedFamily('stale');
        const kept = await ownerA.client.rpc('resolve_account_health_keep_without_account', {
          p_case_id: family.familyContact, p_organization_id: orgA.id,
        });
        assert.equal(kept.error, null, kept.error?.message);
        assert.equal(kept.data?.case?.state, 'reviewed_without_account');

        const next = await createSharedFamily('stale-next');
        await must(service.from('registration_contacts').update({ email: next.email }).eq('id', family.familyContact), 'change family email');

        const detail = await ownerA.client.rpc('get_account_health_case', {
          p_case_id: family.familyContact, p_organization_id: orgA.id,
        });
        assert.equal(detail.data?.case?.state, 'attention');
        assert.equal(detail.data?.case?.reason_code, 'shared_email');
        const history = await must(service.from('account_health_resolutions').select('id,status,resolution_code').eq('registration_contact_id', family.familyContact), 'stale history');
        assert.ok(history.some((row) => row.resolution_code === 'keep_without_account' && row.status === 'active'));
      });

      test('concorrencia recusa e-mail proprio e reopen com estado stale', async () => {
        const family = await createSharedFamily('race');
        const kept = await ownerA.client.rpc('resolve_account_health_keep_without_account', {
          p_case_id: family.familyContact, p_organization_id: orgA.id,
        });
        assert.equal(kept.error, null, kept.error?.message);

        const staleEmail = await administratorA.client.rpc('correct_account_health_email', {
          p_case_id: family.familyContact,
          p_organization_id: orgA.id,
          p_email: `health-v2-race-own-${suffix}@qa.local`,
          p_email_confirm: `health-v2-race-own-${suffix}@qa.local`,
        });
        assert.ok(staleEmail.error, 'tela antiga nao pode informar e-mail apos keep');

        const doubleKeep = await administratorA.client.rpc('resolve_account_health_keep_without_account', {
          p_case_id: family.familyContact, p_organization_id: orgA.id,
        });
        assert.ok(doubleKeep.error, 'segundo keep deve falhar');

        const reopened = await ownerA.client.rpc('reopen_account_health_resolution', {
          p_case_id: family.familyContact, p_organization_id: orgA.id,
        });
        assert.equal(reopened.error, null, reopened.error?.message);
        const history = await must(service.from('account_health_resolutions').select('id,status').eq('registration_contact_id', family.familyContact), 'reopen history');
        assert.ok(history.some((row) => row.status === 'reopened'));
        assert.equal(history.some((row) => row.status === 'active'), false);

        const secondReopen = await administratorA.client.rpc('reopen_account_health_resolution', {
          p_case_id: family.familyContact, p_organization_id: orgA.id,
        });
        assert.ok(secondReopen.error, 'reopen com tela antiga deve falhar');
      });

      test('anon e outra org nao resolvem; counts nao duplicam revisados', async () => {
        const family = await createSharedFamily('scope');
        const before = await ownerA.client.rpc('list_account_health_cases', {
          p_organization_id: orgA.id, p_state: 'all', p_search: family.email, p_limit: 25, p_offset: 0,
        });
        const beforeAttention = Number(before.data?.counts?.attention ?? 0);
        const beforeReviewed = Number(before.data?.counts?.reviewed_without_account ?? 0);

        const anonDenied = await anon.rpc('resolve_account_health_keep_without_account', {
          p_case_id: family.familyContact, p_organization_id: orgA.id,
        });
        assert.ok(anonDenied.error);

        const cross = await ownerB.client.rpc('resolve_account_health_keep_without_account', {
          p_case_id: family.familyContact, p_organization_id: orgA.id,
        });
        assert.ok(cross.error);

        const kept = await ownerA.client.rpc('resolve_account_health_keep_without_account', {
          p_case_id: family.familyContact, p_organization_id: orgA.id,
        });
        assert.equal(kept.error, null, kept.error?.message);

        const after = await ownerA.client.rpc('list_account_health_cases', {
          p_organization_id: orgA.id, p_state: 'all', p_search: family.email, p_limit: 25, p_offset: 0,
        });
        assert.equal(Number(after.data.counts.reviewed_without_account), beforeReviewed + 1);
        assert.equal(Number(after.data.counts.attention), beforeAttention - 1);
        const rows = rowsOf(after.data);
        assert.equal(rows.filter((row) => row.registration_contact_id === family.familyContact && row.state === 'reviewed_without_account').length, 1);
        assert.equal(rows.filter((row) => row.registration_contact_id === family.familyContact && row.state === 'attention').length, 0);
      });
    }
  }
}
