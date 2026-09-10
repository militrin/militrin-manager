import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { categorizeInviteError, buildInviteErrorCopy } from '../src/lib/auth/invite-error-copy.ts';
import { AUTH_EMAIL_OTP_EXPIRY_SECONDS, authLinkExpiresAtFromSend } from '../src/lib/auth/email-otp-ttl.ts';
import {
  INVITE_TEMPLATE_AFTER,
  MAGIC_LINK_TEMPLATE_AFTER,
  INVITE_TEMPLATE_BEFORE,
  MAGIC_LINK_TEMPLATE_BEFORE,
} from '../src/lib/auth/email-template-preview.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('TTL canônico do link Auth é 24h e reenvio deriva nova validade do novo envio', () => {
  assert.equal(AUTH_EMAIL_OTP_EXPIRY_SECONDS, 86_400);
  const sent = new Date('2026-09-09T18:12:00.000Z');
  const expires = authLinkExpiresAtFromSend(sent);
  assert.equal(expires.toISOString(), '2026-09-10T18:12:00.000Z');
  const resent = new Date('2026-09-10T16:28:00.000Z');
  assert.equal(authLinkExpiresAtFromSend(resent).toISOString(), '2026-09-11T16:28:00.000Z');
});

test('mensagem ambígua do GoTrue não vira "Link expirado"', () => {
  assert.equal(categorizeInviteError({ message: 'Token has expired or is invalid' }), 'invalid');
  assert.equal(categorizeInviteError({ code: 'otp_expired', message: 'otp expired' }), 'expired');
  assert.equal(categorizeInviteError({ message: 'Email link is invalid or has expired' }), 'invalid');
  assert.equal(categorizeInviteError({ message: 'Token already used' }), 'already_used');
  const generic = buildInviteErrorCopy('invalid', 'invite');
  assert.equal(generic.title, 'Este link não é mais válido.');
  assert.match(generic.message, /expirado, já ter sido utilizado ou ter sido substituído/);
  assert.equal(generic.ctaLabel, 'Receber novo link');
  assert.equal(buildInviteErrorCopy('expired', 'invite').title, 'Este link expirou.');
  assert.equal(buildInviteErrorCopy('already_used', 'invite').title, 'Este link já foi utilizado.');
});

test('GET da página intermediária não consome token; POST consome via verifyOtp', async () => {
  const page = await read('src/app/auth/confirmar/page.tsx');
  const form = await read('src/app/auth/confirmar/ConfirmFirstAccessForm.tsx');
  const action = await read('src/app/auth/confirmar/actions.ts');
  const getRoute = await read('src/app/auth/confirm/route.ts');
  assert.doesNotMatch(page, /verifyOtp/);
  assert.doesNotMatch(form, /verifyOtp/);
  assert.doesNotMatch(getRoute, /verifyOtp/);
  assert.match(getRoute, /\/auth\/confirmar/);
  assert.match(action, /verifyOtp/);
  assert.match(action, /token_hash: tokenHash/);
  assert.match(form, /type="submit"/);
  assert.match(form, /confirmFirstAccessOtpAction/);
});

test('EmailOtpType instalado em @supabase/auth-js inclui invite e magiclink', async () => {
  const types = await read('node_modules/@supabase/auth-js/dist/module/lib/types.d.ts');
  assert.match(types, /export type EmailOtpType = 'signup' \| 'invite' \| 'magiclink' \| 'recovery' \| 'email_change' \| 'email'/);
});

test('Invite e Magic Link usam type explícito no template; nunca {{ .Type }}', async () => {
  const action = await read('src/app/auth/confirmar/actions.ts');
  const types = await read('src/lib/auth/email-otp-types.ts');
  assert.match(action, /"invite"/);
  assert.match(action, /"magiclink"/);
  assert.match(types, /'invite' as const satisfies EmailOtpType/);
  assert.match(types, /'magiclink' as const satisfies EmailOtpType/);
  assert.match(INVITE_TEMPLATE_AFTER, /token_hash=\{\{ \.TokenHash \}\}/);
  assert.match(MAGIC_LINK_TEMPLATE_AFTER, /token_hash=\{\{ \.TokenHash \}\}/);
  assert.match(INVITE_TEMPLATE_AFTER, /type=invite/);
  assert.match(MAGIC_LINK_TEMPLATE_AFTER, /type=magiclink/);
  assert.doesNotMatch(INVITE_TEMPLATE_AFTER, /\{\{ \.Type \}\}/);
  assert.doesNotMatch(MAGIC_LINK_TEMPLATE_AFTER, /\{\{ \.Type \}\}/);
  assert.match(INVITE_TEMPLATE_BEFORE, /\{\{ \.ConfirmationURL \}\}/);
  assert.match(MAGIC_LINK_TEMPLATE_BEFORE, /\{\{ \.ConfirmationURL \}\}/);
});

test('/auth/confirmar não é indexável, não guarda cache e não manda Referer', async () => {
  const layout = await read('src/app/auth/confirmar/layout.tsx');
  const page = await read('src/app/auth/confirmar/page.tsx');
  const form = await read('src/app/auth/confirmar/ConfirmFirstAccessForm.tsx');
  const config = await read('next.config.ts');
  const strip = await read('src/app/auth/confirmar/StripConfirmQuery.tsx');
  const getRoute = await read('src/app/auth/confirm/route.ts');
  assert.match(layout, /index: false/);
  assert.match(layout, /referrer: "no-referrer"/);
  assert.match(layout, /force-dynamic/);
  assert.match(config, /Referrer-Policy/);
  assert.match(config, /no-store/);
  assert.match(config, /noindex/);
  assert.match(form, /referrerPolicy="no-referrer"/);
  assert.match(page, /StripConfirmQuery/);
  assert.match(strip, /replaceState/);
  assert.doesNotMatch(strip, /verifyOtp/);
  assert.match(getRoute, /no-store/);
  assert.doesNotMatch(page, /gtag|analytics|posthog|plausible/i);
  assert.doesNotMatch(layout, /gtag|analytics|posthog|plausible/i);
});

test('dispatch carimba envio Auth sem criar segundo usuário no reenvio', async () => {
  const dispatch = await read('src/lib/account/first-access-invite-dispatch.ts');
  assert.match(dispatch, /stampInviteAuthEmailSent/);
  assert.match(dispatch, /auth_email_sent_at/);
  assert.match(dispatch, /auth_link_expires_at/);
  assert.match(dispatch, /shouldCreateUser: false/);
  assert.match(dispatch, /inviteUserByEmail/);
});

test('Central não consulta auth.users por linha e não reintroduz N+1', async () => {
  const page = await read('src/app/convites/page.tsx');
  const list = await read('src/app/convites/invite-center-list.tsx');
  const actions = await read('src/app/convites/actions.ts');
  const ttl = await read('supabase/migrations/20261016000000_invite_center_auth_link_ttl.sql');
  assert.match(page, /getCurrentPermissionMap\(\[\.\.\.INVITE_CENTER_PERMISSIONS\]\)/);
  assert.match(page, /loadInviteCenter\(query\)/);
  assert.doesNotMatch(page, /for \(.*\)[\s\S]*getUser\(/);
  assert.doesNotMatch(list, /getUser|auth\.admin|current_user_has_permission/);
  assert.doesNotMatch(actions, /rows\.map\(async/);
  assert.match(actions, /rpc\('list_invite_center'/);
  const listStart = ttl.indexOf('create or replace function public.list_invite_center');
  const listEnd = ttl.indexOf('create or replace function public.get_invite_center_detail');
  const listFn = ttl.slice(listStart, listEnd > listStart ? listEnd : undefined);
  assert.doesNotMatch(listFn, /auth\.users/);
  assert.match(ttl, /p_status in \('reenvio', 'resendable'\) and a\.ui_status in \('expirado', 'falha'\)/);
});

test('copy da Central/cadastro não diz que o link vale 7 dias', async () => {
  const list = await read('src/app/convites/invite-center-list.tsx');
  const cadastro = await read('src/app/cadastros/invite-account-button.tsx');
  const detail = await read('src/app/convites/[rowKey]/page.tsx');
  assert.doesNotMatch(list, /7 dias/);
  assert.doesNotMatch(cadastro, /7 dias no cadastro interno/);
  assert.match(cadastro, /válido por 24 horas após o envio/);
  assert.match(detail, /Link válido até/);
  assert.match(detail, /Registro interno até/);
});

test('bulk preview recorta só link Auth expirado/falha e declara que não envia', async () => {
  const sql = await read('supabase/migrations/20261016000000_invite_center_auth_link_ttl.sql');
  const original = await read('supabase/migrations/20261015000000_invite_center.sql');
  const bulk = await read('src/app/convites/invite-center-bulk.tsx');
  assert.match(original, /sends_nothing', true/);
  assert.match(sql, /p_status in \('reenvio', 'resendable'\) and a\.ui_status in \('expirado', 'falha'\)/);
  assert.match(bulk, /Este preview não envia nada/);
  assert.match(bulk, /links Auth expirados/);
  assert.doesNotMatch(bulk, /Promise\.all\(/);
});
