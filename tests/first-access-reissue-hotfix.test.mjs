import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateParticipantInviteAccess } from '../src/lib/account/participant-invite-policy.ts';
import {
  chooseFirstAccessInviteId,
  firstAccessOnboardingPath,
  inviteIdFromInternalPath,
  parseInviteId,
} from '../src/lib/account/first-access-invite-url.ts';
import {
  INVITE_TEMPLATE_AFTER,
  MAGIC_LINK_TEMPLATE_AFTER,
} from '../src/lib/auth/email-template-preview.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';

const [
  dispatch,
  page,
  confirmActions,
  callback,
  destinations,
  claimMigration,
  canonicalMigration,
  existingAuthTests,
] = await Promise.all([
  read('src/lib/account/first-access-invite-dispatch.ts'),
  read('src/app/primeiro-acesso/page.tsx'),
  read('src/app/auth/confirmar/actions.ts'),
  read('src/app/auth/callback/AuthCallbackClient.tsx'),
  read('src/lib/auth/callback-destinations.ts'),
  read('supabase/migrations/20261105000000_first_access_reissue_correlation.sql'),
  read('supabase/migrations/20261106000000_canonical_ticket_ownership_invariant.sql'),
  read('tests/first-access-existing-auth-cpf.test.mjs'),
]);

test('CASO 1 — Auth inexistente continua no inviteUserByEmail', () => {
  assert.match(dispatch, /admin\.auth\.admin\.inviteUserByEmail/);
  assert.match(dispatch, /participant_invite_id: input\.inviteId/);
  assert.match(dispatch, /shouldCreateUser: false/);
  const inviteBranch = dispatch.slice(dispatch.indexOf('inviteUserByEmail'));
  assert.match(inviteBranch, /authUserId: result\.data\.user\?\.id/);
});

test('CASO 2/3 — reenvio associa Auth existente ao convite atual e manda invite no redirect', () => {
  assert.match(dispatch, /associateInviteAuthUser\(input\.inviteId, existingAuthId\)/);
  assert.match(dispatch, /participant_invite_id: input\.inviteId/);
  assert.match(dispatch, /updateUserById/);
  assert.match(dispatch, /firstAccessOnboardingPath\(inviteId\)/);
  assert.equal(firstAccessOnboardingPath(B), `/primeiro-acesso?invite=${B}`);
  assert.match(dispatch, /\/auth\/callback\?next=/);
});

test('CASO 3 — URL B + metadata A nao seleciona A', () => {
  const chosen = chooseFirstAccessInviteId({
    urlInviteId: B,
    metadataInviteId: A,
    liveInviteIds: [B],
  });
  assert.equal(chosen.inviteId, B);
  assert.equal(chosen.source, 'url');
  assert.equal(chosen.ignoredStaleMetadata, true);
});

test('CASO 3 — sessao sem URL usa o convite vivo B, nunca metadata A', () => {
  const chosen = chooseFirstAccessInviteId({
    urlInviteId: null,
    metadataInviteId: A,
    liveInviteIds: [B],
  });
  assert.equal(chosen.inviteId, B);
  assert.equal(chosen.source, 'live');
  assert.equal(chosen.ignoredStaleMetadata, true);
});

test('CASO 4 — link antigo A continua A para a politica rejeitar', () => {
  const chosen = chooseFirstAccessInviteId({
    urlInviteId: A,
    metadataInviteId: B,
    liveInviteIds: [B],
  });
  assert.equal(chosen.inviteId, A);
  assert.equal(evaluateParticipantInviteAccess({
    inviteId: A,
    inviteStatus: 'revoked',
    expiresAt: '2026-09-16T20:28:02.000Z',
    inviteEmail: 'alschapanski@gmail.com',
    authUserId: USER,
    claimedUserId: null,
    participantUserId: null,
    userId: USER,
    userEmail: 'alschapanski@gmail.com',
    metadataInviteId: A,
    nowMs: Date.parse('2026-09-18T13:00:00.000Z'),
  }), 'inactive');
});

test('CASO 5 — URL B + outro Auth e blocked', () => {
  assert.equal(evaluateParticipantInviteAccess({
    inviteId: B,
    inviteStatus: 'pending',
    expiresAt: '2026-09-24T20:56:58.000Z',
    inviteEmail: 'alschapanski@gmail.com',
    authUserId: USER,
    claimedUserId: null,
    participantUserId: null,
    userId: OTHER_USER,
    userEmail: 'outra@example.com',
    metadataInviteId: B,
    nowMs: Date.parse('2026-09-18T13:00:00.000Z'),
  }), 'wrong_session');
});

test('CASO 6 — invite id de terceiro nao e trocado pelo convite vivo da sessao', () => {
  const chosen = chooseFirstAccessInviteId({
    urlInviteId: OTHER,
    metadataInviteId: B,
    liveInviteIds: [B],
  });
  assert.equal(chosen.inviteId, OTHER);
  assert.equal(chosen.source, 'url');
  assert.equal(evaluateParticipantInviteAccess({
    inviteId: OTHER,
    inviteStatus: 'pending',
    expiresAt: '2026-09-24T20:56:58.000Z',
    inviteEmail: 'terceiro@example.com',
    authUserId: OTHER_USER,
    claimedUserId: null,
    participantUserId: null,
    userId: USER,
    userEmail: 'alschapanski@gmail.com',
    metadataInviteId: B,
    nowMs: Date.parse('2026-09-18T13:00:00.000Z'),
  }), 'wrong_session');
});

test('CASO 7 — prepare reutiliza pending em vez de revogar e criar id novo', () => {
  const prepareStart = claimMigration.indexOf('create or replace function public.prepare_registration_contact_account_invite');
  const prepareEnd = claimMigration.indexOf('create or replace function public.reconcile_registration_contact_account');
  const prepare = claimMigration.slice(prepareStart, prepareEnd);
  assert.match(prepare, /status = 'pending'/);
  assert.match(prepare, /returning id into v_id/);
  assert.doesNotMatch(prepare, /set status = 'revoked'/);
  assert.match(page, /chooseFirstAccessInviteId/);
});

test('CASO 8/9 — 20261105 pulava ownership; 20261106 materializa so intended_owner', () => {
  const claimStart = claimMigration.indexOf('create or replace function public.claim_registration_contact_account_invite');
  const claimEnd = claimMigration.indexOf('\n$$;', claimStart);
  const claim = claimMigration.slice(claimStart, claimEnd);
  assert.match(claim, /skip_ticket_ownership_on_account_claim/);
  assert.doesNotMatch(claim, /materialize_intended_ticket_owners_for_contact/);
  assert.match(claimMigration, /if current_setting\('app.skip_ticket_ownership_on_account_claim', true\) = '1' then\s+return 0;/);
  assert.match(claimMigration, /current_setting\('app.skip_ticket_ownership_on_account_claim', true\) is distinct from '1'/);
  assert.doesNotMatch(claim, /update public\.tickets/);
  assert.match(canonicalMigration, /reconcile_registration_contact_account\(v_contact\.id, v_actor\)/);
  assert.match(canonicalMigration, /trg_materialize_tickets_when_contact_account_linked/);
  assert.doesNotMatch(canonicalMigration, /skip_ticket_ownership_on_account_claim/);
  assert.match(canonicalMigration, /where t\.intended_owner_contact_id = p_contact_id\s+and t\.owner_user_id is null/);
});

test('redirect/confirmar preservam invite do convite atual', () => {
  const destination = firstAccessOnboardingPath(B);
  const redirectTo = `https://www.militrin.com.br/auth/callback?next=${encodeURIComponent(destination)}`;
  const href = `https://www.militrin.com.br/auth/confirmar?token_hash=abc&type=invite&next=${redirectTo}`;
  const nextParam = new URL(href).searchParams.get('next');
  const unwrapped = new URL(nextParam).searchParams.get('next');
  assert.ok(!destination.includes('&'));
  assert.equal(inviteIdFromInternalPath(unwrapped), B);
  assert.ok(!redirectTo.split('?next=')[1].includes('&'), 'RedirectTo nao pode quebrar o querystring do template');
  assert.equal(parseInviteId('not-a-uuid'), null);
  assert.match(destinations, /unwrapAuthDestination/);
  assert.match(destinations, /AUTH_WRAPPER_PATHS/);
  assert.match(destinations, /inviteIdFromInternalPath/);
  assert.match(INVITE_TEMPLATE_AFTER, /next=\{\{ \.RedirectTo \}\}/);
  assert.match(MAGIC_LINK_TEMPLATE_AFTER, /next=\{\{ \.RedirectTo \}\}/);
  assert.match(confirmActions, /inviteIdFromAuthDestination\(destination\)/);
  assert.match(callback, /stampFirstAccessAuthFromSessionAction\(inviteIdFromAuthDestination\(destination\)\)/);
});

test('markFirstAccessAuthConfirmed renova expires_at e nao exige convite interno ainda vigente', () => {
  assert.match(dispatch, /\.eq\('status', 'pending'\)/);
  assert.match(dispatch, /expires_at: inviteExpiresAt/);
  assert.doesNotMatch(dispatch, /\.gt\('expires_at', now\)/);
});

test('metadata deixa de ser a unica fonte do onboarding', () => {
  assert.match(page, /listLiveFirstAccessInviteIdsForUser/);
  assert.doesNotMatch(page, /params\.invite \|\| inviteIdFromSession/);
  assert.doesNotMatch(existingAuthTests, /so correlaciona auth_user_id quando o metadata/);
});
