import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { classifyPasswordUpdateError, sanitizedPasswordUpdateLog } from '../src/lib/auth/password-update-errors.ts';

test('same_password e tratado como senha ja definida -- retry deve seguir, nao abortar', () => {
  const classified = classifyPasswordUpdateError({
    name: 'AuthApiError',
    status: 422,
    code: 'same_password',
    message: 'New password should be different from the old password.',
  });
  assert.equal(classified.alreadySet, true);
  assert.equal(classified.category, 'already_set');
  assert.equal(classified.code, 'same_password');
  assert.equal(classified.userMessage, '');
});

test('sessao ausente/expirada pede novo acesso', () => {
  const missing = classifyPasswordUpdateError({
    name: 'AuthSessionMissingError',
    message: 'Auth session missing!',
  });
  assert.equal(missing.category, 'session_expired');
  assert.equal(missing.alreadySet, false);
  assert.match(missing.userMessage, /sessão de primeiro acesso expirou/i);

  const reauth = classifyPasswordUpdateError({
    code: 'reauthentication_needed',
    message: 'Reauthentication required',
    status: 401,
  });
  assert.equal(reauth.category, 'session_expired');
});

test('senha fraca/pwned usa mensagem da politica, sem texto cru do provedor', () => {
  const classified = classifyPasswordUpdateError({
    code: 'weak_password',
    message: 'Password is known to be weak and easy to guess, please choose a different one.',
    status: 422,
  });
  assert.equal(classified.category, 'weak_password');
  assert.match(classified.userMessage, /senha mais forte/);
  assert.doesNotMatch(classified.userMessage, /known to be weak/);
});

test('rate limit e falha temporaria tem mensagens proprias', () => {
  const rate = classifyPasswordUpdateError({
    code: 'over_request_rate_limit',
    message: 'email rate limit exceeded',
    status: 429,
  });
  assert.equal(rate.category, 'rate_limit');
  assert.match(rate.userMessage, /Muitas tentativas/);

  const unknown = classifyPasswordUpdateError({
    code: 'unexpected_failure',
    message: 'database error granting user',
    status: 500,
  });
  assert.equal(unknown.category, 'temporary');
  assert.equal(unknown.userMessage, 'Não foi possível concluir agora. Tente novamente.');
});

test('log sanitizado nunca inclui senha, token ou mensagem crua do provedor', () => {
  const error = {
    name: 'AuthApiError',
    status: 422,
    code: 'same_password',
    message: 'New password should be different from the old password. token=secret',
  };
  const log = sanitizedPasswordUpdateLog(error, classifyPasswordUpdateError(error));
  const serialized = JSON.stringify(log);
  assert.equal(log.category, 'already_set');
  assert.equal(log.code, 'same_password');
  assert.equal(log.status, 422);
  assert.doesNotMatch(serialized, /token=/i);
  assert.doesNotMatch(serialized, /secret/);
  assert.doesNotMatch(serialized, /different from the old password/);
});

const action = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
const form = await readFile(new URL('../src/app/primeiro-acesso/FirstAccessForm.tsx', import.meta.url), 'utf8');
const page = await readFile(new URL('../src/app/primeiro-acesso/page.tsx', import.meta.url), 'utf8');
const inviteContext = await readFile(new URL('../src/lib/account/participant-invite.ts', import.meta.url), 'utf8');
const dispatch = await readFile(new URL('../src/lib/account/first-access-invite-dispatch.ts', import.meta.url), 'utf8');

test('primeiro acesso continua obrigatorio: senha >=8, diferente do CPF, confirmacao igual', () => {
  assert.match(action, /newPassword\.length < 8/);
  assert.match(action, /newPassword === cpf/);
  assert.match(action, /newPassword !== confirmPassword/);
  assert.match(form, /type="password" minLength=\{8\}/);
});

test('updateUser falho so aborta quando a senha AINDA nao esta no Auth; same_password segue o cadastro', () => {
  const passwordBlock = action.slice(
    action.indexOf('if (passwordUpdate.error)'),
    action.indexOf('const profileUpdate = await upsertCustomerProfileCompat'),
  );
  assert.match(passwordBlock, /classifyPasswordUpdateError\(passwordUpdate\.error\)/);
  assert.match(passwordBlock, /if \(!classified\.alreadySet\)/);
  assert.match(passwordBlock, /return \{ success: false, code: classified\.code, message: classified\.userMessage \}/);
  assert.match(passwordBlock, /\[first-access:password-update\]/);
  assert.doesNotMatch(passwordBlock, /passwordUpdate\.error\.message/);
  assert.doesNotMatch(passwordBlock, /formData\.get\('new_password'\)/);
  assert.doesNotMatch(action, /Não foi possível atualizar a senha\. Tente novamente\./);
});

test('retry apos senha no Auth e falha posterior nao cria outra Auth e so avanca o convite pendente', () => {
  const passwordAt = action.indexOf('supabase.auth.updateUser');
  const stampAt = action.indexOf("password_setup_completed_at: new Date().toISOString()");
  const profileAt = action.indexOf('upsertCustomerProfileCompat(supabase');
  const claimAt = action.indexOf("rpc('claim_registration_contact_account_invite'");
  assert.ok(passwordAt > 0 && passwordAt < stampAt && stampAt < profileAt && profileAt < claimAt);
  assert.match(inviteContext, /requiresPasswordSetup: Boolean\(invite\.requires_password_setup\) && !invite\.password_setup_completed_at/);
  assert.match(dispatch, /shouldCreateUser: false/);
  assert.match(dispatch, /inviteUserByEmail/);
  assert.doesNotMatch(action, /admin\.auth\.admin\.createUser/);
  assert.doesNotMatch(action, /deleteUser/);
});

test('sessao valida continua exigida; convite ancora o mesmo usuario Auth', () => {
  assert.match(action, /if \(!user\?\.id\)/);
  assert.match(page, /if \(!user\?\.id\)/);
  assert.match(action, /auth_user_id\.is\.null,auth_user_id\.eq\.\$\{user\.id\}/);
  assert.match(form, /completeFirstAccessAction\(formData\)/);
  assert.match(action, /code: 'session_expired'/);
  assert.match(action, /FIRST_ACCESS_SESSION_EXPIRED_MESSAGE/);
  assert.match(form, /result\.code === 'session_expired'/);
  assert.match(form, /href="\/primeiro-acesso\/reenviar"/);
});
