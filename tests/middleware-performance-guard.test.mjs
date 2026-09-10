import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  AUTH_GET_USER_TIMEOUT_MS,
  hasSupabaseAuthCookie,
  isStaticOrAssetPath,
  pathNeedsUserResolution,
  pathRequiresAuth,
  withTimeout,
} from '../src/lib/auth/middleware-guard.ts';

const middleware = await readFile(new URL('../middleware.ts', import.meta.url), 'utf8');
const homeButton = await readFile(new URL('../src/components/HomeButton.tsx', import.meta.url), 'utf8');
const theme = await readFile(new URL('../src/lib/theme/get-brand-theme.ts', import.meta.url), 'utf8');

test('rotas públicas e assets não exigem resolução de usuário no middleware', () => {
  assert.equal(pathRequiresAuth('/'), false);
  assert.equal(pathRequiresAuth('/entrar'), false);
  assert.equal(pathRequiresAuth('/politica-de-privacidade'), false);
  assert.equal(pathRequiresAuth('/exclusao-de-dados'), false);
  assert.equal(pathRequiresAuth('/auth/callback'), false);
  assert.equal(pathRequiresAuth('/primeiro-acesso/reenviar'), false);
  assert.equal(pathNeedsUserResolution('/'), false);
  assert.equal(pathNeedsUserResolution('/entrar'), true);
  assert.equal(pathNeedsUserResolution('/minha-conta'), true);
  assert.equal(isStaticOrAssetPath('/file.svg'), true);
  assert.equal(isStaticOrAssetPath('/favicon.ico'), true);
  assert.equal(isStaticOrAssetPath('/_next/static/chunk.js'), true);
  assert.equal(isStaticOrAssetPath('/minha-conta'), false);
});

test('cookie Auth é detectado sem ler o valor', () => {
  assert.equal(hasSupabaseAuthCookie(['theme']), false);
  assert.equal(hasSupabaseAuthCookie(['sb-xxxx-auth-token']), true);
  assert.equal(hasSupabaseAuthCookie(['sb-xxxx-auth-token.0']), true);
  assert.equal(hasSupabaseAuthCookie(['sb-xxxx-auth-token-code-verifier']), false);
});

test('withTimeout não deixa promise pendurada além do limite', async () => {
  const started = Date.now();
  const result = await withTimeout(new Promise(() => {}), 40);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.ok(Date.now() - started < 300);
  const ok = await withTimeout(Promise.resolve(7), 200);
  assert.deepEqual(ok, { ok: true, value: 7 });
});

test('middleware só resolve getUser com cookie, tem timeout e matcher positivo', () => {
  assert.match(middleware, /hasAuthCookie/);
  assert.match(middleware, /authUnresolved/);
  assert.match(middleware, /AUTH_GET_USER_TIMEOUT_MS/);
  assert.match(middleware, /skip_no_cookie/);
  assert.match(middleware, /next_auth_unresolved/);
  assert.ok(AUTH_GET_USER_TIMEOUT_MS <= 4000);
  assert.match(middleware, /matcher:\s*\[/);
  assert.match(middleware, /'\/minha-conta'/);
  assert.match(middleware, /'\/entrar'/);
  assert.doesNotMatch(middleware, /\/\(\(\?!_next\/static/);
  assert.doesNotMatch(middleware, /getUser\(\);\s*\n\s*const \{ pathname/);
});

test('HomeButton e tema não bloqueiam página pública com getUser/query sem timeout', () => {
  assert.match(homeButton, /hasSupabaseAuthCookie/);
  assert.doesNotMatch(homeButton, /getUser/);
  assert.match(theme, /withTimeout/);
  assert.match(theme, /DEFAULT_BRAND_THEME/);
});
