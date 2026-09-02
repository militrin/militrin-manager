// Auditoria final do fluxo Auth/PKCE (antes de configurar os templates no
// Dashboard do Supabase e publicar). Cobre o que auth-invite-pkce-fix.test.mjs
// ainda nao testava de forma concreta:
//   - open redirect: exemplos reais de ataque (https://evil.com, //evil.com,
//     javascript:, data:) contra sanitizeInternalNextPath/safeAuthDestination,
//     executando as funcoes de verdade (nao so regex no texto-fonte) --
//     ambas sao modulos puros, sem 'server-only', entao dá pra importar e
//     rodar diretamente aqui.
//   - allowlist de `type` aceito por /auth/confirm (nunca um valor
//     arbitrario).
//   - a correcao aplicada NESTA auditoria: /auth/confirm agora gera o token
//     de estado de recuperacao (recovery=...) direto no servidor apos
//     verifyOtp(type=recovery) ter sucesso, em vez de depender de `next`
//     carregar esse token (que so acontecia no fluxo PKCE antigo via
//     /auth/callback) -- sem isso, migrar o template de Recuperacao pra
//     token_hash quebraria 100% das redefinicoes de senha.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
// sanitizeInternalNextPath e password-recovery-state.ts sao modulos "folha"
// (sem nenhum import @/ proprio) -- dá pra importar e rodar de verdade sob
// node puro. callback-destinations.ts importa @/lib/utils/safe-navigation
// (alias nao resolvivel fora do bundler do Next), entao safeAuthDestination
// e' auditado por leitura de codigo-fonte (mesmo padrao ja usado em
// auth-invite-pkce-fix.test.mjs) em vez de import direto.
import { sanitizeInternalNextPath } from '../src/lib/utils/safe-navigation.ts';
import { createPasswordRecoveryState, verifyPasswordRecoveryState } from '../src/lib/account/password-recovery-state.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const confirmRoute = await read('src/app/auth/confirm/route.ts');
const destinations = await read('src/lib/auth/callback-destinations.ts');

// Reimplementacao fiel de safeAuthDestination usando o sanitizeInternalNextPath
// JA IMPORTADO E EXECUTADO DE VERDADE acima -- so a combinacao final com a
// allowlist (linha a linha identica ao arquivo real, confirmada por regex
// abaixo) roda aqui fora do bundler.
const ALLOWED_AUTH_DESTINATION_PREFIXES = ['/primeiro-acesso', '/redefinir-senha'];
function safeAuthDestination(value, fallback = '/primeiro-acesso') {
  const safe = sanitizeInternalNextPath(value, fallback);
  const isAllowed = ALLOWED_AUTH_DESTINATION_PREFIXES.some((prefix) => safe === prefix || safe.startsWith(`${prefix}?`));
  return isAllowed ? safe : fallback;
}

test('callback-destinations.ts define a mesma allowlist e a mesma logica de combinacao testadas aqui (esta reimplementacao no teste nao diverge do arquivo real)', () => {
  assert.match(destinations, /export const ALLOWED_AUTH_DESTINATION_PREFIXES = \['\/primeiro-acesso', '\/redefinir-senha'\];/);
  assert.match(destinations, /const safe = sanitizeInternalNextPath\(value, fallback\);/);
  assert.match(destinations, /\(prefix\) => safe === prefix \|\| safe\.startsWith\(`\$\{prefix\}\?`\)/);
});

// -------------------- 10) next externo e sempre rejeitado --------------------

test('10) next externo e sempre rejeitado -- sanitizeInternalNextPath cai no fallback pra cada exemplo de ataque pedido', () => {
  const fallback = '/minha-conta';
  const attacks = [
    'https://evil.com',
    'http://evil.com',
    '//evil.com',
    '//evil.com/primeiro-acesso',
    'javascript:alert(1)',
    '/javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    '/data:text/html,x',
    '\\\\evil.com',
    'HTTPS://EVIL.COM',
  ];
  for (const attack of attacks) {
    assert.equal(sanitizeInternalNextPath(attack, fallback), fallback, `deveria rejeitar: ${attack}`);
  }
});

test('10b) next externo e sempre rejeitado por safeAuthDestination tambem quando o path teria passado em sanitizeInternalNextPath mas nao esta na allowlist de destino de auth', () => {
  // /minha-conta e' um path interno valido, mas NAO esta na allowlist de
  // destinos pos-verificacao de link de auth (ALLOWED_AUTH_DESTINATION_PREFIXES)
  // -- so /primeiro-acesso e /redefinir-senha podem ser destino.
  assert.equal(safeAuthDestination('/minha-conta', '/primeiro-acesso'), '/primeiro-acesso');
  assert.equal(safeAuthDestination('https://evil.com', '/primeiro-acesso'), '/primeiro-acesso');
  assert.equal(safeAuthDestination('//evil.com', '/primeiro-acesso'), '/primeiro-acesso');
});

// -------------------- 11) next interno valido e aceito --------------------

test('11) next interno valido e aceito -- exemplos citados pelo pedido (/primeiro-acesso, /minha-conta, /redefinir-senha)', () => {
  assert.equal(sanitizeInternalNextPath('/primeiro-acesso', '/fallback'), '/primeiro-acesso');
  assert.equal(sanitizeInternalNextPath('/minha-conta', '/fallback'), '/minha-conta');
  assert.equal(sanitizeInternalNextPath('/redefinir-senha', '/fallback'), '/redefinir-senha');
  assert.equal(sanitizeInternalNextPath('/primeiro-acesso?next=/minha-conta/ingressos', '/fallback'), '/primeiro-acesso?next=/minha-conta/ingressos');
});

test('11b) safeAuthDestination aceita os dois prefixos permitidos (com e sem querystring)', () => {
  assert.equal(safeAuthDestination('/primeiro-acesso?invite=abc', '/x'), '/primeiro-acesso?invite=abc');
  assert.equal(safeAuthDestination('/redefinir-senha?recovery=abc', '/x'), '/redefinir-senha?recovery=abc');
  assert.deepEqual(ALLOWED_AUTH_DESTINATION_PREFIXES, ['/primeiro-acesso', '/redefinir-senha']);
});

// -------------------- 9) type invalido e sempre rejeitado --------------------

test('9) /auth/confirm mantem allowlist explicita de type -- nunca aceita um valor arbitrario do querystring', () => {
  assert.match(confirmRoute, /const allowedOtpTypes = new Set<EmailOtpType>\(\["invite", "signup", "magiclink", "recovery", "email", "email_change"\]\);/);
  assert.match(confirmRoute, /if \(!tokenHash \|\| !typeParam \|\| !allowedOtpTypes\.has\(typeParam as EmailOtpType\)\) \{/);
  // O redirecionamento de erro pra type invalido nunca ecoa o valor bruto
  // recebido de volta pro usuario (so a categoria fixa "invalid").
  assert.match(confirmRoute, /linkError=invalid&kind=\$\{kind\}/);
});

// -------------------- correcao desta auditoria: recovery state via /auth/confirm --------------------

test('/auth/confirm gera o token de recovery state no servidor apos verifyOtp(type=recovery) ter sucesso, e redireciona direto pra /redefinir-senha com ele -- nunca depende de `next` carregar o token', () => {
  assert.match(confirmRoute, /import \{ createPasswordRecoveryState \} from "@\/lib\/account\/password-recovery-state";/);
  const recoveryBranch = confirmRoute.slice(confirmRoute.indexOf('if (kind === "recovery")'));
  assert.match(recoveryBranch, /const recoveryState = createPasswordRecoveryState\(email\);/);
  assert.match(recoveryBranch, /redirect\(new URL\(`\/redefinir-senha\?recovery=\$\{encodeURIComponent\(recoveryState\)\}`, request\.url\)\)/);
});

test('token de recovery state (createPasswordRecoveryState/verifyPasswordRecoveryState) faz round-trip valido pro mesmo e-mail e rejeita e-mail diferente, token adulterado ou expirado', () => {
  process.env.PASSWORD_RECOVERY_STATE_SECRET ??= 'test-only-secret-for-audit';
  const token = createPasswordRecoveryState('user@example.test');
  assert.equal(verifyPasswordRecoveryState(token, 'user@example.test'), true);
  assert.equal(verifyPasswordRecoveryState(token, 'other@example.test'), false, 'token nao deve validar pra outro e-mail');
  assert.equal(verifyPasswordRecoveryState(`${token}x`, 'user@example.test'), false, 'token adulterado nao deve validar');
  assert.equal(verifyPasswordRecoveryState('', 'user@example.test'), false, 'token vazio (next sem recovery=) nao deve validar -- exatamente o bug que motivou a correcao');
  const oneHourOneMs = 60 * 60 * 1000 + 1;
  const past = createPasswordRecoveryState('user@example.test', Date.now() - oneHourOneMs);
  assert.equal(verifyPasswordRecoveryState(past, 'user@example.test'), false, 'token expirado (>1h) nao deve validar');
});

// -------------------- 14) Magic Link/Recovery nunca resetam flags de onboarding --------------------

test('14) /auth/confirm nunca escreve em customer_profiles/must_change_password/must_complete_profile/requires_password_setup -- verifyOtp so estabelece sessao, nenhum flag de onboarding e tocado por nenhum kind (invite/magiclink/recovery/signup)', () => {
  assert.doesNotMatch(confirmRoute, /customer_profiles/);
  assert.doesNotMatch(confirmRoute, /must_change_password/);
  assert.doesNotMatch(confirmRoute, /must_complete_profile/);
  assert.doesNotMatch(confirmRoute, /requires_password_setup/);
  // O unico efeito colateral alem da sessao (escrita nos cookies via
  // createServerSupabaseClient, ja implicita em verifyOtp) e' mintar o
  // token de recovery state -- nenhuma outra escrita em nenhuma tabela.
  const sideEffectCalls = confirmRoute.match(/await \w[\w.]*\(/g) ?? [];
  assert.deepEqual([...new Set(sideEffectCalls)], ['await createServerSupabaseClient(', 'await supabase.auth.verifyOtp(']);
});

// -------------------- 12) erro tecnico nunca vaza --------------------

test('12) erro tecnico do provedor nunca aparece na URL de redirecionamento de erro nem em log -- so categoria fixa + kind', () => {
  assert.doesNotMatch(confirmRoute, /linkError=\$\{error\.message\}/);
  assert.doesNotMatch(confirmRoute, /console\.\w+\([^)]*error\.message/);
  assert.match(confirmRoute, /logSanitizedAuthLinkFailure\(\{ kind, category, rawCode: \(error as \{ code\?: string \}\)\.code \?\? null \}\);/);
});
