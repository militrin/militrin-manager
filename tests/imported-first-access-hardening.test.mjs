import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const action = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/app/primeiro-acesso/page.tsx', import.meta.url), 'utf8');
const inviteContext = await readFile(new URL('../src/lib/account/participant-invite.ts', import.meta.url), 'utf8');
const inviteActions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
const accountLayout = await readFile(new URL('../src/app/minha-conta/layout.tsx', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260920000000_harden_imported_account_onboarding.sql', import.meta.url), 'utf8');

test('Invite novo e reenvio por Magic Link preservam exigencia de senha e perfil', () => {
  assert.match(inviteActions, /requireFirstAccessPassword\(input\.inviteId\)/);
  assert.match(inviteActions, /requires_password_setup: true/);
  assert.match(inviteActions, /must_change_password: mustChangePassword/);
  assert.match(inviteActions, /must_complete_profile: true/);
  assert.match(inviteActions, /inviteUserByEmail/);
  assert.match(inviteActions, /signInWithOtp[\s\S]*shouldCreateUser: false/);
  assert.match(inviteActions, /signInWithOtp[\s\S]*markInvitedAccountPending/);
});

test('migration repara convites ativos antigos e mantem onboarding pendente', () => {
  assert.match(migration, /new\.requires_password_setup := true/);
  assert.match(migration, /account_status[\s\S]*'pending_activation'/);
  assert.match(migration, /must_change_password[\s\S]*true/);
  assert.match(migration, /must_complete_profile[\s\S]*true/);
  assert.match(migration, /where status in \('pending', 'claimed'\)[\s\S]*password_setup_completed_at is null/);
  assert.match(migration, /account_status = case[\s\S]*'blocked'/);
});

test('submissao invalida nao executa senha, perfil, claim, pendencias ou flags finais', () => {
  const validationAt = action.indexOf('if (!validation.success) return validationFailure');
  const passwordAt = action.indexOf('supabase.auth.updateUser');
  const profileAt = action.indexOf('upsertCustomerProfileCompat(supabase');
  const claimAt = action.indexOf("rpc('claim_participant_account_invite'");
  const issuesAt = action.indexOf("rpc('resolve_ticket_data_issues'");
  const flagsAt = action.indexOf('must_change_password: false');
  assert.ok(validationAt > 0);
  for (const mutationAt of [passwordAt, profileAt, claimAt, issuesAt, flagsAt]) assert.ok(validationAt < mutationAt);
});

test('sucesso segue senha, perfil, claim, pendencias e somente entao limpa flags', () => {
  const passwordAt = action.indexOf('supabase.auth.updateUser');
  const passwordCompletedAt = action.indexOf('password_setup_completed_at: new Date().toISOString()');
  const profileAt = action.indexOf('upsertCustomerProfileCompat(supabase');
  const claimAt = action.indexOf("rpc('claim_participant_account_invite'");
  const issuesAt = action.indexOf("rpc('resolve_ticket_data_issues'");
  const flagsAt = action.indexOf('must_change_password: false');
  assert.ok(passwordAt < passwordCompletedAt);
  assert.ok(passwordCompletedAt < profileAt);
  assert.ok(profileAt < claimAt);
  assert.ok(claimAt < issuesAt);
  assert.ok(issuesAt < flagsAt);
});

test('senha aparece enquanto convite exige setup e nao reaparece apos conclusao', () => {
  assert.match(inviteContext, /requiresPasswordSetup: Boolean\(invite\.requires_password_setup\) && !invite\.password_setup_completed_at/);
  assert.match(page, /mustChangePassword=\{inviteContext \? inviteContext\.requiresPasswordSetup : status\.mustChangePassword\}/);
  assert.match(inviteActions, /!invitePerson\.password_setup_completed_at/);
});

test('usuario normal usa apenas flag propria e conta incompleta nao acessa Minha Conta', () => {
  assert.match(page, /inviteContext \? inviteContext\.requiresPasswordSetup : status\.mustChangePassword/);
  assert.match(accountLayout, /flags\.firstAccessRequired[\s\S]*redirect\('\/primeiro-acesso\?next=\/minha-conta'\)/);
});
