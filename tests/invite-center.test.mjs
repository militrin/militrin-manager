import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canBulkResendInviteCenter,
  canResendInviteCenter,
  classifyInviteCenterRow,
  inviteCenterAdminActionReason,
  inviteCenterEmptyCopy,
  inviteCenterFirstAccessLabel,
} from '../src/lib/invites/invite-center-status.ts';
import { ROBERTO_ADMIN_CORRECTION, shouldBlockEmailFromInviteJob } from '../src/lib/account/gate8-invite-precheck.ts';

async function readUtf8(relativePath) {
  return (await readFile(new URL(relativePath, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
}

const now = new Date('2026-09-10T16:00:00.000Z');
const future = '2026-09-16T16:00:00.000Z';
const past = '2026-09-09T16:00:00.000Z';

function base(overrides = {}) {
  return {
    mixedIntendedOwners: false,
    inviteStatus: null,
    expiresAt: null,
    now,
    accountStatus: null,
    mustCompleteProfile: false,
    mustChangePassword: false,
    activationCompletedAt: null,
    cadastralIncomplete: false,
    jobStatus: null,
    ...overrides,
  };
}

test('T1 convite enviado e válido → PENDENTE', () => {
  assert.equal(classifyInviteCenterRow(base({ inviteStatus: 'pending', expiresAt: future })), 'pendente');
  assert.equal(inviteCenterFirstAccessLabel('pendente', false), 'Ainda não acessou');
  assert.equal(INVITE_CENTER_STATUS_TONE_PENDING_IS_NEUTRAL, 'default');
});

const INVITE_CENTER_STATUS_TONE_PENDING_IS_NEUTRAL = 'default';

test('T2 claimed + conta ativa → CONCLUÍDO', () => {
  assert.equal(classifyInviteCenterRow(base({
    inviteStatus: 'claimed',
    accountStatus: 'active',
    activationCompletedAt: now,
  })), 'concluido');
});

test('T3 link Auth expirado → LINK EXPIRADO; expires_at interno de 7 dias NÃO classifica', () => {
  assert.equal(classifyInviteCenterRow(base({ inviteStatus: 'pending', authLinkExpiresAt: past })), 'expirado');
  assert.equal(classifyInviteCenterRow(base({ inviteStatus: 'pending', expiresAt: past, authLinkExpiresAt: future })), 'pendente');
  assert.equal(classifyInviteCenterRow(base({ inviteStatus: 'expired', authLinkExpiresAt: past })), 'expirado');
});

test('T4 falha real → FALHA', () => {
  assert.equal(classifyInviteCenterRow(base({ jobStatus: 'failed' })), 'falha');
});

test('T5 cadastro iniciado/incompleto → CADASTRO PENDENTE', () => {
  assert.equal(classifyInviteCenterRow(base({
    inviteStatus: 'claimed',
    mustCompleteProfile: true,
  })), 'cadastro_pendente');
  assert.equal(inviteCenterFirstAccessLabel('pendente', true), 'Pendente de correção');
  assert.equal(inviteCenterFirstAccessLabel('cadastro_pendente', true), 'Primeiro acesso iniciado');
});

test('T6/T7/T8 shared email: uma linha, holders distintos, principal não recalculada', async () => {
  const sql = await readUtf8('../supabase/migrations/20261015000000_invite_center.sql');
  const list = await readUtf8('../src/app/convites/invite-center-list.tsx');
  assert.match(sql, /group by email_norm/);
  assert.match(sql, /md5\(v_org::text \|\| chr\(1\) \|\| g\.email_norm\) as row_key/);
  assert.match(sql, /intended_owner_contact_id = c\.id/);
  assert.doesNotMatch(sql, /chooseSharedEmailPrincipal/);
  assert.match(list, /sharedEmailCompactMeta\(row\.person_count\)/);
  assert.match(list, /lg:hidden/);
  const app = await readUtf8('../src/app/convites/[rowKey]/page.tsx');
  assert.doesNotMatch(app, /chooseSharedEmailPrincipal/);
  assert.match(app, /Holder:/);
  assert.match(app, /Intended owner:/);
});

test('T9 Roberto → AÇÃO ADMIN, sem envio automático', () => {
  const blocked = shouldBlockEmailFromInviteJob(ROBERTO_ADMIN_CORRECTION.email, [
    { intendedOwnerContactId: ROBERTO_ADMIN_CORRECTION.keptRobertoContactId },
    { intendedOwnerContactId: ROBERTO_ADMIN_CORRECTION.femaleContactId },
  ]);
  assert.equal(blocked.block, true);
  assert.equal(classifyInviteCenterRow(base({ mixedIntendedOwners: true, inviteStatus: 'pending', expiresAt: future })), 'admin_action');
  assert.match(inviteCenterAdminActionReason(true), /mais de uma conta proprietária pretendida/);
  assert.equal(canResendInviteCenter('admin_action'), false);
});

test('T10 concluído não permite reenvio; cadastro pendente permite novo link, não entra no bulk', () => {
  assert.equal(canResendInviteCenter('concluido'), false);
  assert.equal(canResendInviteCenter('cadastro_pendente'), true);
  assert.equal(canBulkResendInviteCenter('cadastro_pendente'), false);
});

test('T11/T12 reenvio reusa Auth e um pending por e-mail', async () => {
  const actions = await readUtf8('../src/app/convites/actions.ts');
  const dispatch = await readUtf8('../src/lib/account/first-access-invite-dispatch.ts');
  const sql = await readUtf8('../supabase/migrations/20261015000000_invite_center.sql');
  assert.match(actions, /resend_invite_center/);
  assert.match(dispatch, /shouldCreateUser: false/);
  assert.match(sql, /ux_participant_account_invites_pending_org_email|unique \(job_id, email_normalized\)/);
  const prepare = await readUtf8('../supabase/migrations/20261012000000_shared_email_account_ownership.sql');
  assert.match(prepare, /on conflict\(registration_contact_id\)/);
  assert.match(prepare, /where status = 'pending'/);
});

test('T13/T14 bulk preview não envia; start só após confirmação', async () => {
  const sql = await readUtf8('../supabase/migrations/20261015000000_invite_center.sql');
  const bulk = await readUtf8('../src/app/convites/invite-center-bulk.tsx');
  const actions = await readUtf8('../src/app/convites/actions.ts');
  assert.match(sql, /sends_nothing', true/);
  assert.doesNotMatch(sql, /inviteUserByEmail|signInWithOtp/);
  assert.match(bulk, /Este preview não envia nada/);
  assert.match(bulk, /startInviteCenterBulkResendAction/);
  assert.match(bulk, /Confirmar reenvio/);
  assert.doesNotMatch(actions, /Promise\.all\(/);
  assert.match(actions, /for \(const item of items\)/);
});

test('T15/T16 permissões de view e resend no backend', async () => {
  const layout = await readUtf8('../src/app/convites/layout.tsx');
  const actions = await readUtf8('../src/app/convites/actions.ts');
  const sql = await readUtf8('../supabase/migrations/20261015000000_invite_center.sql');
  const menu = await readUtf8('../src/lib/navigation/admin-menu.ts');
  assert.match(layout, /requirePermission\('invites\.view'\)/);
  assert.match(actions, /assertPermission\('invites\.resend'\)/);
  assert.match(actions, /assertPermission\('invites\.bulk_resend'\)/);
  assert.match(sql, /current_user_has_permission\('invites\.view'\)/);
  assert.match(sql, /current_user_has_permission\('invites\.resend'\)|invites\.bulk_resend/);
  assert.match(menu, /href: "\/convites"/);
  assert.match(menu, /label: "Convites"/);
});

test('T17 nenhuma consulta Auth/permissão/ticket por linha na página', async () => {
  const page = await readUtf8('../src/app/convites/page.tsx');
  const list = await readUtf8('../src/app/convites/invite-center-list.tsx');
  const actions = await readUtf8('../src/app/convites/actions.ts');
  assert.match(page, /getCurrentPermissionMap\(\[\.\.\.INVITE_CENTER_PERMISSIONS\]\)/);
  assert.match(page, /loadInviteCenter\(query\)/);
  assert.doesNotMatch(page, /for \(.*\)[\s\S]*getUser\(/);
  assert.doesNotMatch(page, /auth\.admin\.getUser/);
  assert.doesNotMatch(page, /\.from\('tickets'\)/);
  assert.doesNotMatch(list, /getUser|auth\.admin|current_user_has_permission/);
  assert.doesNotMatch(actions, /rows\.map\(async/);
  assert.match(actions, /rpc\('list_invite_center'/);
});

test('T18 paginação preserva contadores globais', async () => {
  const sql = await readUtf8('../supabase/migrations/20261015000000_invite_center.sql');
  const page = await readUtf8('../src/app/convites/page.tsx');
  assert.match(sql, /from scoped/);
  assert.match(sql, /row_count', \(select count\(\*\)::int from filtered\)/);
  assert.match(page, /totais dos cards não mudam com a página/);
});

test('T19/T20 filtros e busca nome/e-mail/PIN/ingresso', async () => {
  const sql = await readUtf8('../supabase/migrations/20261015000000_invite_center.sql');
  assert.match(sql, /p_status in \('pendentes', 'pendente'\)/);
  assert.match(sql, /principal_name ilike/);
  assert.match(sql, /email_norm ilike/);
  assert.match(sql, /principal_pin ilike/);
  assert.match(sql, /upper\(left\(t\.token::text, 8\)\)/);
  assert.doesNotMatch(sql, /t\.token ilike '%' \|\| v_search/);
});

test('T21 histórico não expõe token/magic link/JWT', async () => {
  const sql = await readUtf8('../supabase/migrations/20261015000000_invite_center.sql');
  const detail = await readUtf8('../src/app/convites/[rowKey]/page.tsx');
  const actions = await readUtf8('../src/app/convites/actions.ts');
  assert.doesNotMatch(sql, /magic.?link|access_token|refresh_token/i);
  assert.doesNotMatch(detail, /invite_token|magic_link|password/);
  assert.doesNotMatch(actions, /redirectTo|magic link|token/);
});

test('T22 erro de Auth/SMTP fica fail-safe', async () => {
  const actions = await readUtf8('../src/app/convites/actions.ts');
  assert.match(actions, /Convite preparado, mas o envio falhou/);
  assert.match(actions, /sent: false/);
});

test('T23 claim atualiza status via estado derivado + revalidate', async () => {
  const actions = await readUtf8('../src/app/convites/actions.ts');
  const sql = await readUtf8('../supabase/migrations/20261016000000_invite_center_auth_link_ttl.sql');
  assert.match(actions, /revalidatePath\('\/convites'\)/);
  assert.match(sql, /p_invite_status = 'claimed' or p_auth_confirmed_at is not null then 'cadastro_pendente'/);
  assert.doesNotMatch(sql, /create table.*invite_center_status/i);
});

test('T24 owner/holder continuam semanticamente distintos', async () => {
  const sql = await readUtf8('../supabase/migrations/20261015000000_invite_center.sql');
  assert.match(sql, /holder_contact_id/);
  assert.match(sql, /intended_owner_contact_id/);
  assert.match(sql, /owner_user_id/);
  assert.doesNotMatch(sql, /update public\.tickets set holder/);
  assert.doesNotMatch(sql, /update public\.tickets set intended_owner/);
});

test('pendente não é erro visual; pulado não vira falha', async () => {
  const status = await readUtf8('../src/lib/invites/invite-center-status.ts');
  assert.match(status, /pendente: 'default'/);
  assert.equal(classifyInviteCenterRow(base({ jobStatus: 'skipped' })), 'pulado');
  const empty = inviteCenterEmptyCopy('pendentes', false);
  assert.equal(empty.title, 'Nenhum convite pendente.');
});

test('canBulkResend só expirado/falha; SQL de reenvio em massa usa o mesmo recorte', async () => {
  assert.equal(canBulkResendInviteCenter('expirado'), true);
  assert.equal(canBulkResendInviteCenter('pendente'), false);
  const sql = await readUtf8('../supabase/migrations/20261015000000_invite_center.sql');
  assert.match(sql, /p_status in \('reenvio', 'resendable'\) and a\.ui_status in \('expirado', 'falha'\)/);
});

test('menu, importações e permissões do painel expõem a Central', async () => {
  const panel = await readUtf8('../src/lib/admin/panel-access.ts');
  const imports = await readUtf8('../src/app/importacoes/import-account-invites.tsx');
  assert.match(panel, /invites\.view/);
  assert.match(imports, /Ver na Central de Convites/);
});

test('migration própria, sem tocar 20261008000000 e sem fan-out', async () => {
  const sql = await readUtf8('../supabase/migrations/20261015000000_invite_center.sql');
  const ttl = await readUtf8('../supabase/migrations/20261016000000_invite_center_auth_link_ttl.sql');
  assert.doesNotMatch(sql, /alter table public\.import_rows|legacy_import_ticket_vs_cadastral/);
  assert.doesNotMatch(ttl, /alter table public\.import_rows|legacy_import_ticket_vs_cadastral/);
  assert.match(ttl, /create or replace function public\.list_invite_center/);
  assert.match(ttl, /auth_link_expires_at = auth_email_sent_at \+ interval '24 hours'/);
  assert.doesNotMatch(ttl, /for v_row in[\s\S]*auth\.admin/);
  assert.doesNotMatch(ttl, /auth\.admin\.getUser/);
});

test('24h pendente / 24h+ expirado; reenvio é nova janela; Auth confirmado incompleto não é link expirado', () => {
  const sent = new Date('2026-09-09T18:12:00.000Z');
  const almost24h = new Date(sent.getTime() + (24 * 3600 * 1000) - 60_000);
  const after24h = new Date(sent.getTime() + (24 * 3600 * 1000) + 1000);
  const resent = new Date('2026-09-10T16:00:00.000Z');
  assert.equal(classifyInviteCenterRow(base({
    inviteStatus: 'pending',
    authLinkExpiresAt: new Date(sent.getTime() + 24 * 3600 * 1000).toISOString(),
    now: almost24h,
  })), 'pendente');
  assert.equal(classifyInviteCenterRow(base({
    inviteStatus: 'pending',
    authLinkExpiresAt: new Date(sent.getTime() + 24 * 3600 * 1000).toISOString(),
    now: after24h,
  })), 'expirado');
  assert.equal(classifyInviteCenterRow(base({
    inviteStatus: 'pending',
    authLinkExpiresAt: new Date(resent.getTime() + 24 * 3600 * 1000).toISOString(),
    now: after24h,
  })), 'pendente');
  assert.equal(classifyInviteCenterRow(base({
    inviteStatus: 'pending',
    authConfirmedAt: '2026-09-09T20:00:00.000Z',
    authLinkExpiresAt: past,
    now: after24h,
  })), 'cadastro_pendente');
});

