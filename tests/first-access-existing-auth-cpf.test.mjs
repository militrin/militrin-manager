import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

  const [
  dispatch,
  firstAccess,
  cadastroActions,
  cadastroPage,
  card,
  policy,
  migration,
  callback,
  confirmActions,
] = await Promise.all([
  read('src/lib/account/first-access-invite-dispatch.ts'),
  read('src/app/primeiro-acesso/actions.ts'),
  read('src/app/cadastros/actions.ts'),
  read('src/app/cadastros/[id]/page.tsx'),
  read('src/app/cadastros/contact-account-card.tsx'),
  read('src/lib/account/participant-invite-policy.ts'),
  read('supabase/migrations/20261103000000_first_access_existing_auth_invite_authorize.sql'),
  read('src/app/auth/callback/AuthCallbackClient.tsx'),
  read('src/app/auth/confirmar/actions.ts'),
]);

test('reenvio de Auth confirmada associa o convite atual e atualiza a referencia canonica', () => {
  const resend = dispatch.slice(
    dispatch.indexOf('if (isResend)'),
    dispatch.indexOf('const result = await admin.auth.admin.inviteUserByEmail'),
  );
  assert.match(resend, /find_auth_email_confirmation_status/);
  assert.match(resend, /updateUserById/);
  assert.match(resend, /participant_invite_id: input\.inviteId/);
  assert.match(resend, /associateInviteAuthUser\(input\.inviteId, existingAuthId\)/);
  assert.match(resend, /signInWithOtp[\s\S]*shouldCreateUser: false/);
  assert.match(resend, /authUserId: correlatableAuthId/);
});

test('concluir cadastro carimba auth_user_id na senha mesmo quando o convite ainda nao tinha correlacao', () => {
  assert.match(firstAccess, /find_conflicting_registration_contact/);
  assert.match(firstAccess, /Este CPF já está vinculado a outra conta/);
  assert.match(firstAccess, /auth_user_id: user\.id/);
  assert.match(firstAccess, /auth_user_id\.is\.null,auth_user_id\.eq\.\$\{user\.id\}/);
  assert.match(firstAccess, /claim_registration_contact_account_invite/);
  assert.match(firstAccess, /ensure_registration_contact_for_user/);
});

test('Enviar acesso continua passando pelo convite do Cadastro, nao vincula so por e-mail', () => {
  assert.match(cadastroActions, /associateInviteAuthUser\(prepared\.invite_id, invited\.authUserId\)/);
  assert.match(dispatch, /INVITE_AUTH_USER_MISMATCH/);
  assert.match(dispatch, /auth_user_id\.is\.null,auth_user_id\.eq\.\$\{userId\}/);
  assert.match(policy, /metadataInviteId === input\.inviteId/);
  assert.match(cadastroPage, /Conta vinculada[\s\S]*Não vinculada/);
  assert.match(card, /existing_confirmed/);
  assert.match(card, /Reenviar confirmação/);
});

test('SQL autoriza pending por metadata do convite, nao escreve ticket e nao casa so por e-mail/CPF', () => {
  assert.match(migration, /u\.raw_user_meta_data->>'participant_invite_id' = i\.id::text/);
  assert.match(migration, /lower\(trim\(coalesce\(i\.email, ''\)\)\) = lower\(trim\(coalesce\(u\.email, ''\)\)\)/);
  assert.match(migration, /i\.organization_id = v_org/);
  assert.match(migration, /coalesce\(v_inv\.auth_user_id = v_actor, false\)/);
  assert.match(migration, /v_metadata_invite is not null/);
  assert.match(migration, /other\.user_id = v_actor/);
  assert.match(migration, /lower\(trim\(sibling\.email\)\) = v_auth_email/);
  assert.match(migration, /regexp_replace\(coalesce\(v_contact\.cpf/);
  assert.match(migration, /auth_user_id = coalesce\(auth_user_id, v_actor\)/);
  assert.match(migration, /and \(auth_user_id is null or auth_user_id = v_actor\)/);
  assert.match(migration, /Nao casa so por e-mail ou CPF/);
  assert.doesNotMatch(migration, /update public\.tickets/);
  assert.match(migration, /materialize_intended_ticket_owners_for_contact\(v_contact\.id, v_actor\)/);
});

test('auth_user_id e imutavel no resend, callback, completeFirstAccess e claim', () => {
  assert.match(dispatch, /auth_user_id\.is\.null,auth_user_id\.eq\.\$\{userId\}/);
  assert.match(dispatch, /INVITE_AUTH_USER_MISMATCH/);
  assert.match(firstAccess, /auth_user_id\.is\.null,auth_user_id\.eq\.\$\{user\.id\}/);
  assert.match(confirmActions, /markFirstAccessAuthConfirmed\(userId, inviteId\)/);
  assert.match(callback, /stampFirstAccessAuthFromSessionAction/);
  assert.match(migration, /auth_user_id = coalesce\(auth_user_id, v_actor\)/);
});
