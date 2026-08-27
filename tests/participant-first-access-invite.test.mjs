import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { appBaseUrl, PRODUCTION_APP_ORIGIN } from '../src/lib/urls/app-base-url.ts';

const page = await readFile(new URL('../src/app/primeiro-acesso/page.tsx', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
const cadastroActions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
const callback = await readFile(new URL('../src/app/auth/callback/AuthCallbackClient.tsx', import.meta.url), 'utf8');

// P0 -- bug real encontrado em producao: firstAccessInviteRedirect usava
// `process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"` direto, em vez
// do helper canonico appBaseUrl() (o mesmo que requestPasswordResetAction/
// signUpPublicAccountAction ja usam -- ver tests/password-recovery-flow.test.mjs).
// Sem essa env var configurada no runtime de producao, o convite de primeiro
// acesso (individual, em massa, OU vindo de um job de importacao) mandava um
// redirectTo para http://localhost:3000/auth/callback -- fora da allowlist
// "Redirect URLs" do projeto Supabase, que entao ignora silenciosamente o
// redirect_to e cai no Site URL configurado (a home, que mostra login pra
// visitante). E exatamente o "o link do convite me leva pro login" relatado.
test('convite de primeiro acesso usa o mesmo dominio canonico do fluxo de recuperacao de senha (nunca localhost em producao)', () => {
  assert.match(cadastroActions, /import \{ appBaseUrl \} from ["']@\/lib\/urls\/app-base-url["']/);
  const redirectFn = cadastroActions.slice(cadastroActions.indexOf('function firstAccessInviteRedirect'), cadastroActions.indexOf('type EligibilityRpcRow'));
  assert.match(redirectFn, /appBaseUrl\(\)/);
  assert.doesNotMatch(redirectFn, /process\.env\.NEXT_PUBLIC_APP_URL/, 'nao pode mais ler a env var diretamente -- so via appBaseUrl()');

  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.equal(appBaseUrl(), PRODUCTION_APP_ORIGIN, 'em producao o convite deve resolver pro dominio real, independente de NEXT_PUBLIC_APP_URL');
  if (previous === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previous;
});

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
