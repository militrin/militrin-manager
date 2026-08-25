import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const page = fs.readFileSync('src/app/cadastros/[id]/page.tsx', 'utf8');
const button = fs.readFileSync('src/app/cadastros/invite-account-button.tsx', 'utf8');
const actions = fs.readFileSync('src/app/cadastros/actions.ts', 'utf8');
const firstAccess = fs.readFileSync('src/app/primeiro-acesso/actions.ts', 'utf8');
const inviteContext = fs.readFileSync('src/lib/account/participant-invite.ts', 'utf8');
const migration = fs.readFileSync('supabase/migrations/20260893000000_canonical_contact_account_invites.sql', 'utf8');

test('admin-created contact eligibility does not depend on participant or ticket', () => {
  assert.match(page, /check_registration_contact_account_invite_eligibility/);
  assert.doesNotMatch(page, /firstAccessCandidateParticipantId/);
  assert.match(migration, /prepare_registration_contact_account_invite/);
  assert.match(migration, /participant_id drop not null/);
  assert.match(migration, /event_id drop not null/);
});

test('UI renders canonical eligibility, resend state and blocked reason', () => {
  assert.match(button, /canInvite/);
  assert.match(button, /inviteStatus === "pending" \? "Reenviar convite"/);
  assert.match(button, /Enviar convite para criar conta/);
  assert.match(button, /!canInvite \? <p[^>]*>\{reason\}/);
});

test('canonical contact eligibility covers missing data, conflicts and linked account', () => {
  for (const reason of ['missing_email', 'invalid_email', 'invalid_cpf', 'email_conflict', 'cpf_conflict', 'already_linked']) {
    assert.match(migration, new RegExp(`'${reason}'`));
  }
  assert.match(migration, /current_user_has_permission\('participants\.edit_basic'\)/);
  assert.match(migration, /user_can_access_organization\(v_actor, v_contact\.organization_id\)/);
});

test('pending invite uses the same Auth callback and first-access claim flow', () => {
  assert.match(actions, /inviteCadastroFirstAccessAction\(id: string, anchor/);
  assert.match(actions, /prepare_registration_contact_account_invite/);
  assert.match(actions, /firstAccessInviteRedirect/);
  assert.match(actions, /\/auth\/callback/);
  assert.match(actions, /\/primeiro-acesso/);
  assert.match(inviteContext, /anchorKind: 'participant' \| 'contact'/);
  assert.match(firstAccess, /claim_registration_contact_account_invite/);
});

test('backend permission and organization checks are fail-closed', () => {
  assert.match(actions, /await assertPermission\("participants\.edit_basic"\)/);
  assert.match(migration, /raise exception 'Sem permissao\.'/);
  assert.match(migration, /Cadastro invalido ou sem acesso\./);
  assert.match(migration, /Pessoa invalida para a organizacao do convite\./);
});
