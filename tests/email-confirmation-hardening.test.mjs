import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [middleware, permissions, platformAccess, authRedirects, verificationActions, signupActions, inviteActions, firstAccessActions] = await Promise.all([
  readFile(new URL('../middleware.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/admin/permissions.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/organizations/access.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/account/auth-redirects.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/verifique-seu-email/actions.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/inscricao/actions.ts', import.meta.url), 'utf8'),
  // inviteUserByEmail/signInWithOtp foram movidos de cadastros/actions.ts pra
  // este modulo compartilhado server-only (auditoria PKCE/regularizacao de
  // convite) -- reusado tambem pelo resend publico em /primeiro-acesso/reenviar.
  readFile(new URL('../src/lib/account/first-access-invite-dispatch.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8'),
]);

test('middleware bloqueia conta nao confirmada em rota protegida e deixa conta confirmada seguir', () => {
  assert.match(middleware, /\(requiresAuth \|\| isProtectedApi\) && user && !isEmailConfirmed\(user\)/);
  assert.match(middleware, /confirmationRedirect\.pathname = '\/verifique-seu-email'/);
  assert.match(middleware, /if \(requiresAuth && !user\)/);
  assert.ok(middleware.indexOf('requiresAuth && !user') < middleware.indexOf('(requiresAuth || isProtectedApi) && user && !isEmailConfirmed(user)'));
  assert.match(middleware, /if \(pathname === '\/entrar' && user\)/);
});

test('APIs autenticadas tambem entram no gate de confirmacao sem incluir webhooks publicos', () => {
  const apiList = middleware.slice(middleware.indexOf('const protectedApiPrefixes'), middleware.indexOf('const isProtectedApi'));
  for (const prefix of ['/api/ingressos', '/api/inscricao', '/api/instagram', '/api/loja', '/api/relatorios']) {
    assert.match(apiList, new RegExp(`'${prefix.replaceAll('/', '\\/')}'`));
  }
  assert.doesNotMatch(apiList, /webhooks/);
});

test('callback e pagina de verificacao nao pertencem a lista de rotas protegidas, evitando loop', () => {
  const protectedList = middleware.slice(middleware.indexOf('const protectedPrefixes'), middleware.indexOf('const requiresAuth'));
  assert.doesNotMatch(protectedList, /'\/auth\/callback'/);
  assert.doesNotMatch(protectedList, /'\/verifique-seu-email'/);
});

test('guard administrativo e guard de plataforma rejeitam e-mail nao confirmado', () => {
  assert.match(permissions, /!actorUserId \|\| !isEmailConfirmed\(user\)/);
  assert.match(permissions, /export async function assertPermission/);
  assert.match(platformAccess, /if \(!isEmailConfirmed\(user\)\)/);
});

test('reenvios signup usam callback canonico e primeiro acesso', () => {
  assert.match(authRedirects, /export function signupConfirmationRedirect/);
  assert.match(authRedirects, /\/auth\/callback\?next=/);
  assert.match(authRedirects, /\/primeiro-acesso\?next=/);
  assert.equal((verificationActions.match(/options: \{ emailRedirectTo: signupConfirmationRedirect\(\) \}/g) ?? []).length, 2);
  assert.match(signupActions, /signupConfirmationRedirect\(postSignupDestination\)/);
});

test('confirmacao tem precedencia sobre criacao de perfil no login', () => {
  const login = signupActions.slice(signupActions.indexOf('export async function signInPublicAccountAction'), signupActions.indexOf('export async function signUpPublicAccountAction'));
  const confirmationGate = login.indexOf('if (postAuth.emailConfirmationRequired)');
  const profileCreation = login.indexOf('ensureCustomerProfileForSignedUser');
  assert.ok(confirmationGate > 0);
  assert.ok(profileCreation > confirmationGate);
  assert.match(login, /redirect_to: postAuth\.redirectTo/);
});

test('Invite, Magic Link e primeiro acesso permanecem no fluxo canonico', () => {
  assert.match(inviteActions, /admin\.auth\.admin\.inviteUserByEmail/);
  assert.match(inviteActions, /admin\.auth\.signInWithOtp/);
  assert.match(inviteActions, /shouldCreateUser: false/);
  assert.match(inviteActions, /emailRedirectTo: redirectTo/);
  assert.match(firstAccessActions, /claim_participant_account_invite/);
  assert.match(firstAccessActions, /claim_registration_contact_account_invite/);
  assert.match(firstAccessActions, /supabase\.auth\.updateUser\(\{ password: newPassword \}\)/);
});

test('reenvio publico de primeiro acesso nao exige login nem confirmacao de e-mail', () => {
  assert.match(middleware, /const isPublicFirstAccessResend = pathname === '\/primeiro-acesso\/reenviar'/);
  assert.match(middleware, /&& !isPublicFirstAccessResend/);
});
