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
    url: candidates[0],
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
for (const url of env.urlCandidates ?? [env.url]) {
  if (url && await ping(url)) {
    availableUrl = url;
    break;
  }
}
env.url = availableUrl ?? env.url;
const available = Boolean(availableUrl);
if (!available) {
  test('pending-auth local supabase ausente: pula integracao', () => {
    assert.ok(true);
  });
} else {
  const service = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }

  async function clientFor(email, password) {
    const client = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`login ${email}: ${signIn.error.message}`);
    return client;
  }

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const password = 'SenhaForte!123';
  const orgA = await must(service.from('organizations').insert({ name: 'Pending Auth A', slug: `pending-a-${suffix}` }).select('id').single(), 'orgA');
  const orgB = await must(service.from('organizations').insert({ name: 'Pending Auth B', slug: `pending-b-${suffix}` }).select('id').single(), 'orgB');

  async function makeAdmin(orgId, label) {
    const email = `pending-admin-${label}-${suffix}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), `admin ${label}`);
    await must(service.from('customer_profiles').upsert({
      user_id: created.user.id, cpf: generateValidCpf(), full_name: label, birth_date: '1990-05-05', phone: '11999990001', city: 'Itapiranga', gender: 'male',
    }, { onConflict: 'user_id' }), `${label} profile`);
    const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
    await must(service.from('organization_members').insert({ organization_id: orgId, user_id: created.user.id, is_owner: true, is_active: true }), `${label} member`);
    await must(service.from('admin_users').insert({ user_id: created.user.id, role_id: ownerRole.id, is_active: true }), `${label} admin_users`);
    return clientFor(email, password);
  }

  async function createContact(admin, orgId, email, fullName = 'Pessoa Pendente') {
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

  test('C) Cadastro com e-mail de Auth pendente fica pending_confirmation e nao e elegivel para inviteUserByEmail', async () => {
    const admin = await makeAdmin(orgA.id, 'c');
    const email = `pending-user-c-${suffix}@qa.local`;
    await must(service.auth.admin.createUser({ email, password, email_confirm: false }), 'pending auth C');
    const contactId = await createContact(admin, orgA.id, email);
    const eligibility = await admin.rpc('check_registration_contact_account_invite_eligibility', { p_registration_contact_id: contactId });
    const row = Array.isArray(eligibility.data) ? eligibility.data[0] : eligibility.data;
    assert.equal(eligibility.error, null, eligibility.error?.message);
    assert.equal(row.eligible, false);
    assert.equal(row.reason_code, 'pending_email_confirmation');
    const state = await admin.rpc('get_registration_contact_account_state', { p_registration_contact_id: contactId });
    const stateRow = Array.isArray(state.data) ? state.data[0] : state.data;
    assert.equal(stateRow.state, 'pending_confirmation');
    assert.equal(stateRow.can_resend_confirmation, true);
    assert.equal(stateRow.can_invite, false);
    const prepare = await admin.rpc('prepare_registration_contact_account_invite', { p_registration_contact_id: contactId });
    assert.ok(prepare.error, 'prepare nao deve criar convite para Auth pendente');
  });

  test('E) Auth confirmada sem vinculo oferece invite_existing_confirmed_account', async () => {
    const admin = await makeAdmin(orgA.id, 'e');
    const email = `confirmed-user-e-${suffix}@qa.local`;
    await must(service.auth.admin.createUser({ email, password, email_confirm: true }), 'confirmed auth E');
    const contactId = await createContact(admin, orgA.id, email, 'Pessoa Confirmada');
    const eligibility = await admin.rpc('check_registration_contact_account_invite_eligibility', { p_registration_contact_id: contactId });
    const row = Array.isArray(eligibility.data) ? eligibility.data[0] : eligibility.data;
    assert.equal(row.eligible, true);
    assert.equal(row.reason_code, 'invite_existing_confirmed_account');
  });

  test('F) Auth vinculada a Cadastro de outra org nao vaza e nao vincula', async () => {
    const adminA = await makeAdmin(orgA.id, 'fa');
    const adminB = await makeAdmin(orgB.id, 'fb');
    const email = `cross-org-${suffix}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: true }), 'cross auth');
    const contactB = await createContact(adminB, orgB.id, email, 'Pessoa B');
    await must(service.from('registration_contacts').update({ user_id: created.user.id }).eq('id', contactB), 'link B');
    const contactA = await createContact(adminA, orgA.id, email, 'Pessoa A');
    const eligibility = await adminA.rpc('check_registration_contact_account_invite_eligibility', { p_registration_contact_id: contactA });
    const row = Array.isArray(eligibility.data) ? eligibility.data[0] : eligibility.data;
    assert.equal(row.eligible, false);
    assert.equal(row.reason_code, 'account_attention');
    assert.match(String(row.reason_message), /tratamento administrativo/i);
    const state = await adminA.rpc('get_registration_contact_account_state', { p_registration_contact_id: contactA });
    const stateRow = Array.isArray(state.data) ? state.data[0] : state.data;
    assert.equal(stateRow.state, 'attention');
    assert.equal(stateRow.reason_code, 'account_attention');
    assert.equal(stateRow.can_resend_confirmation, false);
    assert.equal(stateRow.can_invite, false);
    assert.equal(Object.prototype.hasOwnProperty.call(stateRow, 'user_id'), false);
    const serialized = JSON.stringify(stateRow);
    assert.doesNotMatch(serialized, new RegExp(orgB.id, 'i'));
    assert.doesNotMatch(serialized, new RegExp(contactB, 'i'));
    assert.doesNotMatch(serialized, new RegExp(created.user.id, 'i'));
    assert.doesNotMatch(serialized, /Pending Auth B|orgB|outra organiza/i);
    const anon = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const publicLookup = await anon.rpc('find_auth_email_confirmation_status', { p_email: email });
    assert.ok(publicLookup.error, 'anon nao pode enumerar Auth por e-mail');
    const adminLookup = await adminA.rpc('find_auth_email_confirmation_status', { p_email: email });
    assert.ok(adminLookup.error, 'authenticated nao pode enumerar Auth por e-mail');
  });

  test('H) eligibility nao altera tickets.owner_user_id', async () => {
    const admin = await makeAdmin(orgA.id, 'h');
    const pendingEmail = `pending-h-${suffix}@qa.local`;
    await must(service.auth.admin.createUser({ email: pendingEmail, password, email_confirm: false }), 'pending h');
    const contactId = await createContact(admin, orgA.id, pendingEmail, 'Pessoa H');
    const beforeOwners = await service.from('tickets').select('id,owner_user_id').eq('organization_id', orgA.id);
    await admin.rpc('check_registration_contact_account_invite_eligibility', { p_registration_contact_id: contactId });
    await admin.rpc('get_registration_contact_account_state', { p_registration_contact_id: contactId });
    const afterOwners = await service.from('tickets').select('id,owner_user_id').eq('organization_id', orgA.id);
    assert.deepEqual(afterOwners.data ?? [], beforeOwners.data ?? []);
  });

  test('E2E) Auth pendente → Cadastro → resend GoTrue → confirmacao, sem duplicar Auth nem mudar owner', async () => {
    const admin = await makeAdmin(orgA.id, 'e2e');
    const email = `pending-e2e-${suffix}@qa.local`;
    const created = await must(service.auth.admin.createUser({ email, password, email_confirm: false }), 'pending e2e');
    const beforeOwners = await service.from('tickets').select('id,owner_user_id').eq('organization_id', orgA.id);
    const contactId = await createContact(admin, orgA.id, email, 'Pessoa E2E');

    const state = await admin.rpc('get_registration_contact_account_state', { p_registration_contact_id: contactId });
    const stateRow = Array.isArray(state.data) ? state.data[0] : state.data;
    assert.equal(stateRow.state, 'pending_confirmation');
    assert.equal(stateRow.can_resend_confirmation, true);

    const anon = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    await anon.auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: `${env.url.replace(/:\d+$/, ':3000')}/auth/callback?next=${encodeURIComponent('/primeiro-acesso?next=%2Fminha-conta')}` },
    });

    const listed = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const matches = (listed.data?.users ?? []).filter((user) => String(user.email ?? '').toLowerCase() === email);
    assert.equal(matches.length, 1, 'resend nao pode criar segunda Auth');
    assert.equal(matches[0].id, created.user.id);
    const contacts = await service.from('registration_contacts').select('id').eq('organization_id', orgA.id).eq('email', email);
    assert.equal((contacts.data ?? []).length, 1, 'Cadastro deve permanecer unico');
    const afterResendOwners = await service.from('tickets').select('id,owner_user_id').eq('organization_id', orgA.id);
    assert.deepEqual(afterResendOwners.data ?? [], beforeOwners.data ?? []);

    await must(service.auth.admin.updateUserById(created.user.id, { email_confirm: true }), 'confirm e2e');
    const confirmed = await admin.rpc('get_registration_contact_account_state', { p_registration_contact_id: contactId });
    const confirmedRow = Array.isArray(confirmed.data) ? confirmed.data[0] : confirmed.data;
    assert.equal(confirmedRow.state, 'existing_confirmed');
    assert.equal(confirmedRow.can_resend_confirmation, false);
    assert.equal(confirmedRow.can_invite, true);

    await must(service.from('registration_contacts').update({ user_id: created.user.id }).eq('id', contactId), 'link e2e');
    const active = await admin.rpc('get_registration_contact_account_state', { p_registration_contact_id: contactId });
    const activeRow = Array.isArray(active.data) ? active.data[0] : active.data;
    assert.equal(activeRow.state, 'active');
    assert.equal(activeRow.can_resend_confirmation, false);
    const afterOwners = await service.from('tickets').select('id,owner_user_id').eq('organization_id', orgA.id);
    assert.deepEqual(afterOwners.data ?? [], beforeOwners.data ?? []);
  });
}
