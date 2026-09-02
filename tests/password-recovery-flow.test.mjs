import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { appBaseUrl, PRODUCTION_APP_ORIGIN } from '../src/lib/urls/app-base-url.ts';

const actions = await readFile(new URL('../src/app/inscricao/actions.ts', import.meta.url), 'utf8');
const callback = await readFile(new URL('../src/app/auth/callback/AuthCallbackClient.tsx', import.meta.url), 'utf8');
const resetPage = await readFile(new URL('../src/app/redefinir-senha/page.tsx', import.meta.url), 'utf8');
// A allowlist de destino pos-verificacao (antes definida localmente em
// AuthCallbackClient.tsx como ALLOWED_CALLBACK_DESTINATION_PREFIXES) foi
// extraida pra um modulo compartilhado (auditoria PKCE/regularizacao de
// convite), reusado tambem por /auth/confirm -- uma unica fonte de verdade.
const destinations = await readFile(new URL('../src/lib/auth/callback-destinations.ts', import.meta.url), 'utf8');

test('solicitacao usa callback canonico e nunca a home', () => {
  const recovery = actions.slice(actions.indexOf('export async function requestPasswordResetAction'), actions.indexOf('export async function updatePublicPasswordAction'));
  assert.match(recovery, /resetPasswordForEmail/);
  assert.match(recovery, /\/auth\/callback\?next=/);
  assert.match(recovery, /createPasswordRecoveryState\(normalized\)/);
  assert.match(recovery, /`\/redefinir-senha\?recovery=\$\{encodeURIComponent\(recoveryState\)\}`/);
  assert.doesNotMatch(recovery, /redirectTo:\s*appBaseUrl\(\)\s*[,}]/);
});

test('producao usa o dominio www canonico', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.equal(PRODUCTION_APP_ORIGIN, 'https://www.militrin.com.br');
  assert.equal(appBaseUrl(), 'https://www.militrin.com.br');
  if (previous === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previous;
});

test('callback troca credenciais, aceita recovery e bloqueia open redirect', () => {
  assert.match(callback, /exchangeCodeForSession\(code\)/);
  assert.match(callback, /verifyOtp\(\{ token_hash: tokenHash, type:/);
  assert.match(callback, /'recovery'/);
  assert.match(callback, /import \{ safeAuthDestination \} from '@\/lib\/auth\/callback-destinations';/);
  assert.match(destinations, /export const ALLOWED_AUTH_DESTINATION_PREFIXES = \['\/primeiro-acesso', '\/redefinir-senha'\];/);
  assert.match(destinations, /return isAllowed \? safe : fallback;/);
  assert.doesNotMatch(callback, /router\.(replace|push)\(['"]\/['"]\)/);
});

test('redefinicao exige sessao, valida senhas e oferece novo link', () => {
  const update = actions.slice(actions.indexOf('export async function updatePublicPasswordAction'));
  assert.match(update, /password\.length < 8/);
  assert.match(update, /password !== input\.confirmPassword/);
  assert.match(update, /verifyPasswordRecoveryState\(input\.recoveryState, userData\.user\.email/);
  assert.match(update, /supabase\.auth\.getUser\(\)/);
  assert.match(update, /RECOVERY_SESSION_REQUIRED/);
  assert.match(update, /supabase\.auth\.updateUser\(\{ password: input\.password \}\)/);
  assert.doesNotMatch(update, /console\.(log|info|warn|error)[^\n]*password/);
  assert.match(resetPage, /Solicitar novo link/);
  assert.match(resetPage, /new URLSearchParams\(window\.location\.search\)\.get\('recovery'\)/);
  assert.match(resetPage, /Senha alterada com sucesso/);
});
