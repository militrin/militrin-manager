import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  adminAttentionCopy,
  contactAccountStateView,
  linkedOtherAccountLabel,
  mapEligibilityToAccountState,
} from '../src/lib/account/contact-account-state.ts';
import { classifyInviteCenterRow, canResendInviteCenter } from '../src/lib/invites/invite-center-status.ts';
import {
  buildTicketIdentityView,
  classifyTicketHolderAccount,
  isPendingFirstAccessInvite,
} from '../src/lib/registrations/contact-tickets.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  migration,
  cadastroActions,
  cadastroPage,
  accountCard,
  sharedCard,
  manageForm,
  loader,
  firstAccess,
  convitesActions,
  checkoutNamed,
  canonicalOwnership,
  portal,
] = await Promise.all([
  read('supabase/migrations/20261107000000_one_auth_per_normalized_email.sql'),
  read('src/app/cadastros/actions.ts'),
  read('src/app/cadastros/[id]/page.tsx'),
  read('src/app/cadastros/contact-account-card.tsx'),
  read('src/app/cadastros/shared-email-account-card.tsx'),
  read('src/app/cadastros/shared-email-account-manage-form.tsx'),
  read('src/lib/account/load-shared-email-group.ts'),
  read('src/app/primeiro-acesso/actions.ts'),
  read('src/app/convites/actions.ts'),
  read('supabase/migrations/20261030000000_named_checkout_textual_holder_only.sql'),
  read('supabase/migrations/20261106000000_canonical_ticket_ownership_invariant.sql'),
  read('src/lib/account/portal-orders-and-tickets.ts'),
]);

const FRIENDLY = 'Este e-mail já está vinculado a outra conta. Esta pessoa pode permanecer como titular, mas não pode criar uma segunda conta com o mesmo e-mail.';
const uniqueIndex = migration.slice(
  migration.indexOf('create unique index if not exists ux_registration_contacts_one_user_per_normalized_email'),
  migration.indexOf('create or replace function public.trg_registration_contacts_one_auth_per_email'),
);
const claimFn = migration.slice(
  migration.indexOf('create or replace function public.claim_registration_contact_account_invite'),
  migration.indexOf('revoke all on function public.claim_registration_contact_account_invite'),
);
const ensureFn = migration.slice(
  migration.indexOf('create or replace function public.ensure_registration_contact_for_user'),
  migration.indexOf('revoke all on function public.ensure_registration_contact_for_user'),
);

test('A) Cadastro A com Auth e Cadastro B sem user_id no mesmo e-mail continuam permitidos', () => {
  assert.match(uniqueIndex, /where user_id is not null/);
  assert.match(uniqueIndex, /on public\.registration_contacts \(organization_id, \(lower\(trim\(email\)\)\)\)/);
  assert.match(migration, /Nao cria unique\(email\) em registration_contacts/);
});

test('B) segundo user_id no mesmo e-mail/org e bloqueado no banco e na aplicacao', () => {
  assert.match(uniqueIndex, /ux_registration_contacts_one_user_per_normalized_email/);
  assert.match(migration, /trg_registration_contacts_one_auth_per_email/);
  assert.match(migration, /email_already_has_account/);
  assert.match(cadastroActions, /email_already_has_account/);
  assert.match(firstAccess, /EMAIL_ALREADY_LINKED_TO_ANOTHER_USER/);
  assert.match(ensureFn, /EMAIL_ALREADY_LINKED_TO_ANOTHER_USER/);
  assert.match(cadastroActions, new RegExp(FRIENDLY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(firstAccess, new RegExp(FRIENDLY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(cadastroActions, /ux_registration_contacts_one_user_per_normalized_email.{0,40}return \{ success: false as const, message: error\.message \}/);
});

test('C) e-mail e normalizado por lower\(trim\)', () => {
  assert.match(uniqueIndex, /organization_id, \(lower\(trim\(email\)\)\)/);
  assert.match(migration, /create or replace function public\.normalized_contact_email/);
  assert.match(migration, /lower\(trim\(coalesce\(p_email, ''\)\)\)/);
});

test('D) a trava e por organization_id; orgs distintas nao colidem', () => {
  assert.match(uniqueIndex, /on public\.registration_contacts \(organization_id, \(lower\(trim\(email\)\)\)\)/);
  assert.match(migration, /registration_email_account_owner\(\s*p_organization_id/);
  assert.match(migration, /c\.organization_id = p_organization_id/);
});

test('E) titular secundario permanece pessoa sem conta', () => {
  assert.equal(mapEligibilityToAccountState({ reasonCode: 'email_already_has_account' }), 'linked_to_other_account');
  assert.equal(contactAccountStateView('linked_to_other_account').canInvite, false);
  assert.equal(linkedOtherAccountLabel('Malu Bazzanella'), 'Conta: vinculada a Malu Bazzanella');
  assert.match(accountCard, /linked_to_other_account/);
  assert.match(accountCard, /linkedOtherAccountLabel/);
  assert.match(accountCard, /state === "none" \|\| state === "existing_confirmed"/);
  assert.doesNotMatch(accountCard, /state === "linked_to_other_account"[\s\S]{0,80}InviteAccountButton/);
  assert.match(sharedCard, /Conta: vinculada a \$\{principalName\}/);
  assert.match(loader, /groupHasAccount/);
  assert.equal(classifyTicketHolderAccount({
    holderContactUserId: null,
    accountState: 'linked_to_other_account',
    inviteStatus: 'pending',
  }), 'unlinked');
});

test('F) convite para secundario com e-mail ja vinculado e bloqueado com feedback correto', () => {
  assert.equal(adminAttentionCopy('email_already_has_account'), FRIENDLY);
  assert.match(migration, /reason_code = 'email_already_has_account'/);
  assert.match(cadastroPage, /cardCanInvite/);
  assert.match(cadastroPage, /inviteRecord=\{cardState === "linked_to_other_account" \? null : inviteRecord\}/);
  assert.doesNotMatch(accountCard, /state === "linked_to_other_account"[\s\S]{0,200}InviteAccountButton/);
  assert.match(convitesActions, /email_already_has_account/);
  assert.match(convitesActions, new RegExp(FRIENDLY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const classified = classifyInviteCenterRow({
    mixedIntendedOwners: false,
    inviteStatus: 'pending',
    accountStatus: 'active',
    mustCompleteProfile: false,
    mustChangePassword: false,
    activationCompletedAt: null,
    cadastralIncomplete: false,
    jobStatus: null,
  });
  assert.equal(classified, 'concluido');
  assert.equal(canResendInviteCenter(classified), false);
  const linkedGroup = classifyInviteCenterRow({
    mixedIntendedOwners: false,
    inviteStatus: 'pending',
    accountStatus: null,
    mustCompleteProfile: false,
    mustChangePassword: false,
    activationCompletedAt: null,
    cadastralIncomplete: false,
    jobStatus: null,
    groupHasLinkedAccount: true,
  });
  assert.equal(linkedGroup, 'concluido');
  assert.equal(canResendInviteCenter(linkedGroup), false);
});

test('G) compra autenticada com titular terceiro nao cria conta para o holder', () => {
  assert.match(checkoutNamed, /holder_full_name/);
  assert.match(checkoutNamed, /textual holder|titular textual|named_checkout|ownership_mode.*named/i);
  assert.doesNotMatch(checkoutNamed, /registration_contacts[\s\S]{0,200}user_id = auth\.uid\(\)[\s\S]{0,80}holder/);
});

test('H) primeiro acesso nao transfere ownership por igualdade de e-mail', () => {
  assert.doesNotMatch(claimFn, /update public\.tickets[\s\S]{0,200}email/);
  assert.doesNotMatch(ensureFn, /owner_user_id/);
  assert.match(canonicalOwnership, /materialize_intended_ticket_owners_for_contact/);
  assert.match(portal, /\.eq\('owner_user_id', userId\)/);
  assert.doesNotMatch(portal, /\.eq\('email'/);
  assert.doesNotMatch(firstAccess, /owner_user_id.*=.*email/);
});

test('I) Malu conta / Erick titular / sem primeiro acesso pendente valido', () => {
  const malu = 'Malu Bazzanella';
  const erick = 'Erick Vinicius Marquiori';
  assert.equal(linkedOtherAccountLabel(malu), `Conta: vinculada a ${malu}`);
  assert.equal(isPendingFirstAccessInvite('pending'), true);
  assert.equal(isPendingFirstAccessInvite('revoked'), false);
  assert.equal(isPendingFirstAccessInvite('expired'), false);
  const identity = buildTicketIdentityView({
    holderName: erick,
    holderContactUserId: null,
    holderAccountState: 'linked_to_other_account',
    holderInviteStatus: 'pending',
    emailOwnedByOtherAccount: true,
    ownerUserId: '82e14e02-1e96-47b1-8c23-797487afa9f9',
    ownerName: malu,
  });
  assert.equal(identity.holderName, erick);
  assert.equal(identity.holderAccountKind, 'unlinked');
  assert.notEqual(identity.holderAccountLabel, 'Aguardando primeiro acesso');
  assert.equal(identity.ownerName, malu);
  assert.match(cadastroPage, /emailOwnedByOtherAccount/);
  assert.match(manageForm, /não pode criar uma segunda conta com o mesmo e-mail/);
  assert.match(migration, /revoke_registration_contact_pending_invites/);
  assert.match(migration, /status = 'revoked'/);
});
