import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { resolveOrCreateAdminRole } from './helpers/resolve-or-create-admin-role.mjs';

const API = 'http://127.0.0.1:15421';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SERVICE = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const FRIENDLY = 'Este e-mail já está vinculado a outra conta. Esta pessoa pode permanecer como titular, mas não pode criar uma segunda conta com o mesmo e-mail.';

function generateValidCpf() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  function checkDigit(nums) {
    let sum = 0;
    let weight = nums.length + 1;
    for (const n of nums) { sum += n * weight; weight -= 1; }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  }
  return [...base, checkDigit(base), checkDigit([...base, checkDigit(base)])].join('');
}

async function ping() {
  try {
    const response = await fetch(`${API}/auth/v1/health`);
    return response.ok;
  } catch {
    return false;
  }
}

if (!await ping()) {
  test('email-unique local: supabase 15421 ausente, pula integracao', () => {
    assert.ok(true);
  });
} else {
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const service = createClient(API, SERVICE, options);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const password = 'SenhaForte!123';

  async function must(promise, label) {
    const result = await promise;
    if (result.error) throw new Error(`${label}: ${JSON.stringify(result.error)}`);
    return result.data;
  }

  const probe = await service.from('registration_contacts').select('id').limit(1);
  if (probe.error) throw new Error(probe.error.message);

  const org = await must(service.from('organizations').insert({
    name: 'Email Unique A', slug: `email-unique-a-${suffix}`,
  }).select('id').single(), 'org A');
  const otherOrg = await must(service.from('organizations').insert({
    name: 'Email Unique B', slug: `email-unique-b-${suffix}`,
  }).select('id').single(), 'org B');

  const ownerEmail = `owner-${suffix}@qa.local`;
  const owner = await must(service.auth.admin.createUser({
    email: ownerEmail, password, email_confirm: true,
  }), 'org owner auth');
  await must(service.from('customer_profiles').upsert({
    user_id: owner.user.id, cpf: generateValidCpf(), full_name: 'Owner QA', birth_date: '1990-05-05',
    phone: '11999990001', city: 'Itapiranga', gender: 'male',
  }, { onConflict: 'user_id' }), 'owner profile');
  const ownerRole = await resolveOrCreateAdminRole(service, 'owner', 'Owner');
  await must(service.from('organization_members').insert({
    organization_id: org.id, user_id: owner.user.id, is_owner: true, is_active: true,
  }), 'owner member');
  await must(service.from('admin_users').insert({
    user_id: owner.user.id, role_id: ownerRole.id, is_active: true,
  }), 'owner admin_users');

  const ownerClient = createClient(API, ANON, options);
  const signIn = await ownerClient.auth.signInWithPassword({ email: ownerEmail, password });
  if (signIn.error) throw new Error(signIn.error.message);

  const authA = await must(service.auth.admin.createUser({
    email: `shared-${suffix}@qa.local`, password, email_confirm: true,
  }), 'auth A');
  const authB = await must(service.auth.admin.createUser({
    email: `other-${suffix}@qa.local`, password, email_confirm: true,
  }), 'auth B');
  const authOtherOrg = await must(service.auth.admin.createUser({
    email: `orgb-${suffix}@qa.local`, password, email_confirm: true,
  }), 'auth org B');

  await test('A/E) mesmo e-mail: um com user_id e outro sem continua permitido', async () => {
    const principal = await must(service.from('registration_contacts').insert({
      organization_id: org.id,
      full_name: 'Pessoa Principal',
      email: '  TESTE@EMAIL.COM  ',
      cpf: generateValidCpf(),
      user_id: authA.user.id,
    }).select('id,user_id,email').single(), 'contact A');
    const secondary = await must(service.from('registration_contacts').insert({
      organization_id: org.id,
      full_name: 'Pessoa Secundaria',
      email: 'teste@email.com',
      cpf: generateValidCpf(),
      user_id: null,
    }).select('id,user_id,email').single(), 'contact B');
    assert.ok(principal.user_id);
    assert.equal(secondary.user_id, null);
  });

  await test('B/C) segundo user_id no e-mail normalizado e bloqueado', async () => {
    const secondary = await must(service.from('registration_contacts').select('id').eq('organization_id', org.id).eq('full_name', 'Pessoa Secundaria').single(), 'load B');
    const blocked = await service.from('registration_contacts').update({ user_id: authB.user.id }).eq('id', secondary.id).select('id,user_id').maybeSingle();
    assert.ok(blocked.error, 'esperado bloqueio ao vincular segunda Auth');
    const message = `${blocked.error.message} ${blocked.error.details ?? ''} ${blocked.error.hint ?? ''}`;
    assert.match(message, /já está vinculado a outra conta|ux_registration_contacts_one_user_per_normalized_email|duplicate key/i);
    const after = await must(service.from('registration_contacts').select('user_id').eq('id', secondary.id).single(), 'B after');
    assert.equal(after.user_id, null);
  });

  await test('D) mesmo e-mail em outra organization continua permitido', async () => {
    const other = await must(service.from('registration_contacts').insert({
      organization_id: otherOrg.id,
      full_name: 'Pessoa Outra Org',
      email: 'teste@email.com',
      cpf: generateValidCpf(),
      user_id: authOtherOrg.user.id,
    }).select('id,user_id').single(), 'contact other org');
    assert.ok(other.user_id);
  });

  await test('F) elegibilidade de convite do secundario devolve feedback amigavel', async () => {
    const secondary = await must(service.from('registration_contacts').select('id').eq('organization_id', org.id).eq('full_name', 'Pessoa Secundaria').single(), 'load secondary');
    const eligibility = await ownerClient.rpc('check_registration_contact_account_invite_eligibility', {
      p_registration_contact_id: secondary.id,
    });
    if (eligibility.error) {
      assert.match(String(eligibility.error.message), /já está vinculado a outra conta|Sem permissao/i);
      return;
    }
    const row = Array.isArray(eligibility.data) ? eligibility.data[0] : eligibility.data;
    assert.equal(row.eligible, false);
    assert.equal(row.reason_code, 'email_already_has_account');
    assert.equal(row.reason_message, FRIENDLY);
  });
}
