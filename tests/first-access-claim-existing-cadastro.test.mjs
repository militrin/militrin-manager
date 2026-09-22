import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { evaluateParticipantInviteAccess } from '../src/lib/account/participant-invite-policy.ts';
import { chooseFirstAccessInviteId } from '../src/lib/account/first-access-invite-url.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const INVITE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const OTHER_INVITE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const EXPIRED = '2026-09-21T14:53:19.000Z';
const NOW = Date.parse('2026-09-22T16:36:00.000Z');

const [
  page,
  firstAccess,
  dispatch,
  convites,
  policy,
  inviteLoader,
  migration,
] = await Promise.all([
  read('src/app/primeiro-acesso/page.tsx'),
  read('src/app/primeiro-acesso/actions.ts'),
  read('src/lib/account/first-access-invite-dispatch.ts'),
  read('src/app/convites/actions.ts'),
  read('src/lib/account/participant-invite-policy.ts'),
  read('src/lib/account/participant-invite.ts'),
  read('supabase/migrations/20261112000000_first_access_claim_existing_cadastro.sql'),
]);

test('1) Cadastro existente + convite correlacionado reivindica o mesmo contact', () => {
  assert.match(migration, /v_bound_auth := coalesce\(v_inv\.auth_user_id = v_actor, false\)/);
  assert.match(migration, /set user_id = v_actor, updated_at = now\(\)/);
  assert.match(firstAccess, /claim_registration_contact_account_invite/);
  assert.match(firstAccess, /ensure_registration_contact_for_user/);
});

test('2) tela carrega dados do Cadastro do convite, nao pessoa nova', () => {
  assert.match(page, /preferParticipant/);
  assert.match(page, /invitedParticipant\?\.\[field\]/);
  assert.match(page, /Vamos concluir seu cadastro/);
  assert.match(inviteLoader, /registration_contacts.*full_name,cpf,birth_date,gender,phone,email,city/);
});

test('3) CPF do proprio Cadastro claimed nao usa conflito global', () => {
  assert.match(firstAccess, /Com convite valido, o CPF do proprio Cadastro reivindicado nao e conflito/);
  assert.match(firstAccess, /if \(!inviteContext\?\.valid\)/);
  assert.match(firstAccess, /assert_registration_contact_cpf_available/);
});

test('4) CPF de outro Cadastro continua bloqueado', () => {
  assert.match(firstAccess, /CPF_COLLISION_REQUIRES_ADMIN/);
  assert.match(firstAccess, /Este CPF já identifica outra Pessoa/);
});

test('5) shared email nao escolhe Cadastro por coincidencia de e-mail', () => {
  assert.match(policy, /authBound \|\| metadataBound/);
  assert.doesNotMatch(migration, /lower\(trim\(sibling\.email\)\) = v_auth_email/);
  assert.match(migration, /registration_email_account_owner/);
  assert.match(inviteLoader, /\.eq\('auth_user_id', user\.id\)/);
  assert.match(inviteLoader, /\.is\('auth_user_id', null\)/);
});

test('6) reabrir o link e idempotente no claim claimed da mesma Auth', () => {
  assert.match(migration, /if v_inv\.status = 'claimed'/);
  assert.match(migration, /v_inv\.claimed_user_id is distinct from v_actor/);
  assert.match(migration, /return v_contact\.id/);
});

test('7) invite reissued: auth_user_id de outro usuario nao reivindica', () => {
  assert.equal(evaluateParticipantInviteAccess({
    inviteId: OTHER_INVITE,
    inviteStatus: 'pending',
    expiresAt: '2026-09-29T00:00:00.000Z',
    inviteEmail: 'a@example.com',
    authUserId: OTHER_USER,
    claimedUserId: null,
    participantUserId: null,
    userId: USER,
    userEmail: 'a@example.com',
    metadataInviteId: OTHER_INVITE,
    nowMs: NOW,
  }), 'wrong_session');
  assert.equal(chooseFirstAccessInviteId({
    urlInviteId: OTHER_INVITE,
    metadataInviteId: INVITE,
    liveInviteIds: [INVITE],
  }).inviteId, OTHER_INVITE);
});

test('8) claim restaura skip de ownership; materializacao fica na reconcile canonica', () => {
  assert.match(migration, /skip_ticket_ownership_on_account_claim/);
  assert.doesNotMatch(migration, /update public\.tickets/);
  assert.match(migration, /reconcile_registration_contact_account\(v_contact\.id, v_actor\)/);
});

test('9) nao ha insert de registration_contacts no claim', () => {
  assert.doesNotMatch(migration, /insert into public\.registration_contacts/);
  assert.match(firstAccess, /ensure_registration_contact_for_user/);
});

test('10) Ana-equivalent: auth_user_id correlacionado ignora invite.email divergente', () => {
  assert.equal(evaluateParticipantInviteAccess({
    inviteId: INVITE,
    inviteStatus: 'pending',
    expiresAt: '2026-09-29T00:00:00.000Z',
    inviteEmail: 'ritteranaclara2+h.dogui@gmail.com',
    authUserId: USER,
    claimedUserId: null,
    participantUserId: null,
    userId: USER,
    userEmail: 'ritteranaclara2@gmail.com',
    metadataInviteId: INVITE,
    nowMs: NOW,
  }), null);
  assert.match(migration, /if not v_bound_auth and v_auth_email is distinct from lower\(trim\(v_inv\.email\)\)/);
  assert.match(dispatch, /associatedAuthId/);
  assert.match(dispatch, /admin\.auth\.admin\.getUserById\(associatedAuthId\)/);
  assert.match(dispatch, /shouldCreateUser: false/);
});

test('11) captura/Julia: convite interno expirado + Auth ja correlacionada conclui', () => {
  assert.equal(evaluateParticipantInviteAccess({
    inviteId: INVITE,
    inviteStatus: 'pending',
    expiresAt: EXPIRED,
    inviteEmail: 'juliapaulua@gmail.com',
    authUserId: USER,
    claimedUserId: null,
    participantUserId: null,
    userId: USER,
    userEmail: 'juliapaulua@gmail.com',
    metadataInviteId: INVITE,
    nowMs: NOW,
  }), null);
  assert.equal(evaluateParticipantInviteAccess({
    inviteId: INVITE,
    inviteStatus: 'pending',
    expiresAt: EXPIRED,
    inviteEmail: 'juliapaulua@gmail.com',
    authUserId: null,
    claimedUserId: null,
    participantUserId: null,
    userId: USER,
    userEmail: 'juliapaulua@gmail.com',
    metadataInviteId: INVITE,
    nowMs: NOW,
  }), 'inactive');
  assert.match(migration, /v_inv\.expires_at <= now\(\) and not v_bound_auth/);
  assert.match(dispatch, /expires_at: inviteExpiresAt/);
  assert.match(convites, /inviteId: currentInvite\?\.id/);
});

test('metadata-only sem e-mail igual continua wrong_session', () => {
  assert.equal(evaluateParticipantInviteAccess({
    inviteId: INVITE,
    inviteStatus: 'pending',
    expiresAt: '2026-09-29T00:00:00.000Z',
    inviteEmail: 'a@example.com',
    authUserId: null,
    claimedUserId: null,
    participantUserId: null,
    userId: USER,
    userEmail: 'b@example.com',
    metadataInviteId: INVITE,
    nowMs: NOW,
  }), 'wrong_session');
});
