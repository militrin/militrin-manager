// Auditoria: convite de primeiro acesso (inviteUserByEmail) falhava com
// "PKCE code verifier not found in storage..." exibido cru ao destinatario,
// sempre que o link era aberto num navegador/dispositivo diferente daquele
// que "iniciou" o fluxo -- inerente a exchangeCodeForSession (PKCE), que
// exige um code_verifier local, impossivel de existir pra um convite gerado
// pelo admin e aberto em QUALQUER lugar pelo destinatario.
//
// Correcao: /auth/confirm (rota nova, servidor) usa verifyOtp com
// token_hash+type -- caminho oficialmente recomendado pelo Supabase pra SSR
// com link de e-mail, nunca depende de estado local do navegador. /auth/
// callback (cliente) passa a preferir token_hash sobre code, e nunca mais
// expoe texto cru do provedor. Ativacao completa depende de configuracao
// externa do Dashboard do Supabase (template de e-mail) -- documentado no
// relatorio da tarefa, nao aplicavel via codigo/migration.
//
// Testes aqui sao estaticos (leitura de codigo-fonte) -- os cenarios que
// exigem Supabase Auth real rodando (convite de verdade aberto em outro
// navegador) nao sao simulaveis sem um projeto Supabase live; ver relatorio
// para os riscos residuais que exigem teste manual pos-configuracao do
// template.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const confirmRoute = await read('src/app/auth/confirm/route.ts');
const callbackClient = await read('src/app/auth/callback/AuthCallbackClient.tsx');
const errorCopy = await read('src/lib/auth/invite-error-copy.ts');
const destinations = await read('src/lib/auth/callback-destinations.ts');
const resendAction = await read('src/app/primeiro-acesso/reenviar/actions.ts');
const dispatchLib = await read('src/lib/account/first-access-invite-dispatch.ts');
const primeiroAcessoPage = await read('src/app/primeiro-acesso/page.tsx');
const cadastrosActions = await read('src/app/cadastros/actions.ts');

// -------------------- causa raiz / /auth/confirm --------------------

test('1/4) /auth/confirm usa verifyOtp com token_hash+type (nunca exchangeCodeForSession) -- caminho que nunca depende de PKCE verifier local', () => {
  assert.match(confirmRoute, /supabase\.auth\.verifyOtp\(\{ type: typeParam as EmailOtpType, token_hash: tokenHash \}\)/);
  assert.doesNotMatch(confirmRoute, /\.exchangeCodeForSession\(/);
});

test('/auth/confirm roda inteiramente no servidor (createServerSupabaseClient, cookies SSR) -- nunca client-only', () => {
  assert.match(confirmRoute, /import \{ createServerSupabaseClient \} from "@\/lib\/supabase\/server"/);
  assert.match(confirmRoute, /const supabase = await createServerSupabaseClient\(\);/);
  assert.doesNotMatch(confirmRoute, /"use client"/);
});

test('16) token_hash nunca aparece em nenhuma chamada de log (console\\.*) em /auth/confirm', () => {
  const logCalls = confirmRoute.match(/console\.\w+\([^)]*\)/gs) ?? [];
  for (const call of logCalls) assert.doesNotMatch(call, /tokenHash/, `chamada de log nao deve referenciar tokenHash: ${call}`);
});

test('15) callback/confirm nunca aceita redirect externo -- next sempre passa por safeAuthDestination/allowlist', () => {
  assert.match(confirmRoute, /safeAuthDestination\(nextParam, fallbackDestination\)/);
  assert.match(destinations, /export const ALLOWED_AUTH_DESTINATION_PREFIXES = \['\/primeiro-acesso', '\/redefinir-senha'\];/);
  assert.match(destinations, /sanitizeInternalNextPath/);
});

// -------------------- /auth/callback: reordenacao + nunca erro cru --------------------

test('2/3) callback tenta token_hash ANTES de code -- funciona mesmo se o navegador nunca teve um verifier local', () => {
  const tokenHashIndex = callbackClient.indexOf('if (tokenHash && otpType && allowedOtpTypes.has');
  const codeIndex = callbackClient.indexOf('} else if (code) {');
  assert.ok(tokenHashIndex >= 0 && codeIndex > tokenHashIndex, 'token_hash precisa ser verificado antes de code');
});

test('9) convite invalido/expirado nunca mostra mensagem tecnica crua do Supabase ao usuario -- so a copy traduzida (buildInviteErrorCopy)', () => {
  assert.doesNotMatch(callbackClient, /\{errorMessage\}/);
  assert.match(callbackClient, /\{errorCopy\.message\}/);
  assert.match(callbackClient, /buildInviteErrorCopy/);
});

test('16) mensagem crua do provedor nunca e renderizada, so logada (categoria+tipo, nunca o texto original) via logSanitizedAuthLinkFailure', () => {
  assert.match(callbackClient, /logSanitizedAuthLinkFailure\(\{ kind, category, rawCode: shaped\?\.code \?\? null \}\);/);
  assert.doesNotMatch(callbackClient, /console\.\w+\([^)]*shaped\?\.message/);
});

// -------------------- taxonomia de erro segura --------------------

test('mensagens seguras cobrem as 4 categorias pedidas (expirado/ja usado/invalido/erro interno), nunca o texto cru do provedor', () => {
  assert.match(errorCopy, /category === 'expired'/);
  assert.match(errorCopy, /category === 'already_used'/);
  assert.match(errorCopy, /category === 'internal'/);
  assert.match(errorCopy, /expirou\. Solicite um novo/);
  assert.match(errorCopy, /já foi utilizado\. Entre na sua conta ou solicite um novo acesso\./);
  assert.match(errorCopy, /Não foi possível concluir seu acesso agora\. Tente novamente\./);
});

test('categorizacao nunca depende do texto original ser repassado ao usuario -- so retorna uma categoria fixa (enum), nunca a mensagem', () => {
  assert.match(errorCopy, /export function categorizeInviteError\(input: \{ message\?: string \| null; code\?: string \| null \}\): InviteErrorCategory \{/);
});

// -------------------- Invite vs Magic Link vs Recovery vs Signup --------------------

test('14) Magic Link/recovery/signup mantem sua propria categoria e CTA -- nunca tratados como "convite" generico', () => {
  assert.match(errorCopy, /recovery: '\/esqueci-minha-senha'/);
  assert.match(errorCopy, /signup: '\/verifique-seu-email'/);
  assert.match(errorCopy, /invite: '\/primeiro-acesso\/reenviar'/);
  assert.match(errorCopy, /magiclink: '\/primeiro-acesso\/reenviar'/);
});

// -------------------- Botao "Solicitar novo convite" --------------------

test('botao de resend deixou de ser mailto: decorativo -- aponta pro fluxo real em /primeiro-acesso/reenviar, nos dois lugares onde existia', () => {
  assert.doesNotMatch(callbackClient, /mailto:/);
  assert.doesNotMatch(primeiroAcessoPage, /mailto:/);
  assert.match(primeiroAcessoPage, /href="\/primeiro-acesso\/reenviar"/);
});

test('resend self-service NUNCA cria conta/participante/cadastro -- so signInWithOtp(shouldCreateUser:false) via dispatchFirstAccessEmail, nenhuma chamada direta a inviteUserByEmail/insert', () => {
  assert.match(resendAction, /import \{ dispatchFirstAccessEmail \} from "@\/lib\/account\/first-access-invite-dispatch"/);
  assert.doesNotMatch(resendAction, /\.inviteUserByEmail\(/);
  assert.doesNotMatch(resendAction, /\.insert\(/);
  assert.match(dispatchLib, /shouldCreateUser: false/);
});

test('resend self-service reusa o MESMO fluxo canonico (dispatchFirstAccessEmail, reasonCode resend_invite_*) -- nenhuma segunda arquitetura de envio', () => {
  assert.match(resendAction, /reasonCode: "resend_invite_self_service"/);
  assert.match(dispatchLib, /const isResend = input\.reasonCode\.startsWith\('resend_invite_'\);/);
});

test('resend self-service e anti-enumeracao: mensagem generica identica exista ou nao convite pendente pra aquele e-mail', () => {
  const notFoundBranch = resendAction.slice(resendAction.indexOf('if (!invite?.id)'), resendAction.indexOf('if (!invite?.id)') + 200);
  assert.match(notFoundBranch, /return \{ success: true, message: GENERIC_MESSAGE \};/);
  const successBranch = resendAction.slice(resendAction.lastIndexOf('return { success: true, message: GENERIC_MESSAGE };'));
  assert.match(successBranch, /GENERIC_MESSAGE/);
});

test('resend self-service preserva requires_password_setup (via requireFirstAccessPassword, chamado dentro de dispatchFirstAccessEmail, nao reimplementado)', () => {
  assert.match(dispatchLib, /const passwordRequirementError = await requireFirstAccessPassword\(input\.inviteId\);/);
  assert.match(dispatchLib, /requires_password_setup: true/);
});

test('resend self-service so considera convite ainda PENDENTE (status=pending, password_setup_completed_at nulo) -- nunca reusa convite ja concluido', () => {
  assert.match(resendAction, /\.eq\("status", "pending"\)/);
  assert.match(resendAction, /\.is\("password_setup_completed_at", null\)/);
  assert.match(resendAction, /\.eq\("email", email\)/);
  assert.doesNotMatch(resendAction, /\.ilike\("email"/);
});

test('resend self-service repassa rate limit nativo do Supabase (mesma heuristica ja usada por requestPasswordResetAction) -- nao inventa throttle proprio', () => {
  assert.match(resendAction, /rate limit/);
  assert.match(resendAction, /security purposes/);
});

// -------------------- Nucleo compartilhado (nenhuma segunda arquitetura) --------------------

test('dispatchFirstAccessEmail/markInvitedAccountPending/firstAccessInviteRedirect vivem num modulo compartilhado server-only (nunca "use server") -- nao sao Server Actions chamaveis direto do cliente', () => {
  assert.match(dispatchLib, /^import 'server-only';/m);
  assert.doesNotMatch(dispatchLib, /^"use server";/m);
});

test('cadastros/actions.ts (admin, participants.edit_basic) importa do modulo compartilhado em vez de definir a logica de novo', () => {
  assert.match(cadastrosActions, /import \{ dispatchFirstAccessEmail, markInvitedAccountPending \} from "@\/lib\/account\/first-access-invite-dispatch";/);
  assert.doesNotMatch(cadastrosActions, /async function dispatchFirstAccessEmail/);
});

// -------------------- /primeiro-acesso: invite id via sessao, sem depender so da URL --------------------

test('4/7) /primeiro-acesso resolve o convite tambem por user_metadata.participant_invite_id (fallback quando a URL nao carrega ?invite=) -- getParticipantInviteContext revalida elegibilidade do mesmo jeito nos dois casos', () => {
  assert.match(primeiroAcessoPage, /const inviteIdFromSession = typeof user\.user_metadata\?\.participant_invite_id === 'string'/);
  assert.match(primeiroAcessoPage, /const effectiveInviteId = params\.invite \|\| inviteIdFromSession \|\| undefined;/);
  assert.match(primeiroAcessoPage, /getParticipantInviteContext\(effectiveInviteId, user\)/);
});

test('5) requires_password_setup continua vindo do inviteContext quando ha convite valido (nunca sobrescrito pelo fallback de sessao)', () => {
  assert.match(primeiroAcessoPage, /mustChangePassword=\{inviteContext \? inviteContext\.requiresPasswordSetup : status\.mustChangePassword\}/);
});
