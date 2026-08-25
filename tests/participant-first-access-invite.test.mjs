import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../src/app/primeiro-acesso/page.tsx', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
const cadastroActions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
const callback = await readFile(new URL('../src/app/auth/callback/AuthCallbackClient.tsx', import.meta.url), 'utf8');

test('convite sem sessao nunca encaminha o participante para uma tela que exige senha', () => {
  const noUserBranch = page.slice(page.indexOf("if (!user?.id)"), page.indexOf('const status ='));
  assert.match(noUserBranch, /if \(params\.invite\)/);
  assert.match(noUserBranch, /Não foi possível validar o convite/);
  assert.match(noUserBranch, /Solicitar novo convite/);
  assert.ok(noUserBranch.indexOf('if (params.invite)') < noUserBranch.indexOf("redirect('/entrar"));
});

test('convite individual e em massa usam o mesmo primeiro acesso autenticado', () => {
  assert.match(cadastroActions, /function firstAccessInviteRedirect/);
  assert.match(cadastroActions, /\/auth\/callback\?next=/);
  assert.match(cadastroActions, /\/primeiro-acesso\?invite=/);
  assert.match(cadastroActions, /dispatchFirstAccessEmail/);
  assert.match(cadastroActions, /inviteCadastroFirstAccessAction[\s\S]*dispatchFirstAccessEmail/);
  assert.match(cadastroActions, /sendBulkFirstAccessInvitesAction[\s\S]*dispatchFirstAccessEmail/);
  assert.match(callback, /exchangeCodeForSession/);
  assert.match(callback, /verifyOtp/);
});

test('claim atomico ocorre antes de senha e perfil e continua idempotente no banco', () => {
  const actionBody = actions.slice(actions.indexOf('export async function completeFirstAccessAction'));
  const claimAt = actionBody.indexOf("rpc('claim_participant_account_invite'");
  const passwordAt = actionBody.indexOf('supabase.auth.updateUser');
  const profileAt = actionBody.indexOf('upsertCustomerProfileCompat');
  assert.ok(claimAt > 0);
  assert.ok(claimAt < passwordAt);
  assert.ok(claimAt < profileAt);
  assert.equal(actionBody.match(/rpc\('claim_participant_account_invite'/g)?.length, 1);
});
