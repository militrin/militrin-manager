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
  }
}
