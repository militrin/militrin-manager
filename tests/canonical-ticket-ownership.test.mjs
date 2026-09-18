import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildTicketIdentityView } from '../src/lib/registrations/contact-tickets.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  canonical,
  checkoutNamed,
  portal,
  identityUi,
  reasons,
] = await Promise.all([
  read('supabase/migrations/20261106000000_canonical_ticket_ownership_invariant.sql'),
  read('supabase/migrations/20261030000000_named_checkout_textual_holder_only.sql'),
  read('src/lib/account/portal-orders-and-tickets.ts'),
  read('src/lib/registrations/contact-tickets.ts'),
  read('src/lib/admin/sensitive-action-reasons.ts'),
]);

const materialize = canonical.slice(
  canonical.indexOf('create or replace function public.materialize_intended_ticket_owners_for_contact'),
  canonical.indexOf('create or replace function public.trg_ticket_copy_intended_owner'),
);
const copyIntended = canonical.slice(
  canonical.indexOf('create or replace function public.trg_ticket_copy_intended_owner'),
  canonical.indexOf('create or replace function public.trg_initialize_ticket_owner'),
);
const initialize = canonical.slice(
  canonical.indexOf('create or replace function public.trg_initialize_ticket_owner'),
  canonical.indexOf('create or replace function public.trg_zz_ticket_ownership_invariant'),
);
const claim = canonical.slice(
  canonical.indexOf('create or replace function public.claim_registration_contact_account_invite'),
  canonical.indexOf('create or replace function public.preview_intended_ticket_owner_materialization'),
);
const reconcile = canonical.slice(
  canonical.indexOf('create or replace function public.reconcile_registration_contact_account'),
  canonical.indexOf('create or replace function public.claim_registration_contact_account_invite'),
);
const preview = canonical.slice(
  canonical.indexOf('create or replace function public.preview_intended_ticket_owner_materialization'),
  canonical.indexOf('create or replace function public.reconcile_intended_ticket_owners_for_linked_contacts'),
);
const backfill = canonical.slice(
  canonical.indexOf('create or replace function public.reconcile_intended_ticket_owners_for_linked_contacts'),
);
const named = checkoutNamed.slice(checkoutNamed.indexOf('create or replace function public.materialize_named_checkout_holders'));
const self = checkoutNamed.slice(
  checkoutNamed.indexOf('create or replace function public.materialize_self_checkout_holder'),
  checkoutNamed.indexOf('create or replace function public.materialize_named_checkout_holders'),
);

test('A. intended + owner null + primeiro acesso materializa owner', () => {
  assert.match(claim, /set user_id = v_actor/);
  assert.match(claim, /reconcile_registration_contact_account\(v_contact\.id, v_actor\)/);
  assert.match(canonical, /trg_materialize_tickets_when_contact_account_linked/);
  assert.match(materialize, /where t\.intended_owner_contact_id = p_contact_id\s+and t\.owner_user_id is null/);
  assert.match(materialize, /c\.user_id = p_user_id/);
  assert.doesNotMatch(claim, /skip_ticket_ownership_on_account_claim/);
  assert.doesNotMatch(claim, /materialize_intended_ticket_owners_for_contact\(v_contact\.id, v_actor\)/);
});

test('B/L. intended + owner existente: claim nao substitui', () => {
  assert.match(materialize, /and t\.owner_user_id is null/);
  assert.doesNotMatch(materialize, /owner_user_id is distinct from/);
  assert.doesNotMatch(materialize, /set owner_user_id = p_user_id[\s\S]*where t\.intended_owner_contact_id = p_contact_id\s+and t\.owner_user_id is not null/);
});

test('C. holder cria conta e owner de outra conta permanece', () => {
  assert.doesNotMatch(reconcile, /exists \(\s+select 1 from public\.participants as holder/);
  assert.doesNotMatch(reconcile, /item\.registration_contact_id = v_contact\.id/);
  assert.match(reconcile, /materialize_intended_ticket_owners_for_contact\(v_contact\.id, p_user_id\)/);
});

test('D. matching de CPF/e-mail/nome sem intended nao materializa', () => {
  assert.doesNotMatch(materialize, /email|cpf|full_name|phone|telefone/i);
  assert.doesNotMatch(claim, /update public\.tickets/);
  assert.doesNotMatch(reconcile, /lower\(trim\(.*email[\s\S]*tickets/);
});

test('E/F/G. compra autenticada: owner = comprador para si, terceiro e multiplos titulares', () => {
  const accountAt = initialize.indexOf("if v_order.buyer_type = 'account' then");
  const importedAt = initialize.indexOf('if v_is_imported then');
  assert.ok(accountAt >= 0 && (importedAt < 0 || importedAt > accountAt));
  assert.match(initialize, /new\.owner_user_id := v_order\.user_id;/);
  assert.match(initialize, /Pedido de conta sem comprador autenticado valido/);
  assert.doesNotMatch(initialize, /participation_history/);
  assert.doesNotMatch(named, /intended_owner_contact_id/);
  assert.doesNotMatch(named, /update public\.tickets[\s\S]{0,80}owner_user_id\s*=/);
  assert.doesNotMatch(self, /intended_owner_contact_id/);
});

test('H. imported_holder sem Auth: owner null + intended permitido', () => {
  assert.match(initialize, /v_order\.buyer_type = 'imported_holder'/);
  assert.match(initialize, /new\.intended_owner_contact_id := v_registration_contact_id/);
  assert.match(canonical, /TICKET_OWNERSHIP_INCOMPLETE/);
});

test('I. imported_holder conclui primeiro acesso: owner materializado', () => {
  assert.match(canonical, /trg_materialize_tickets_when_contact_account_linked/);
  assert.match(canonical, /after insert or update of user_id/);
  assert.match(claim, /reconcile_registration_contact_account\(v_contact\.id, v_actor\)/);
});

test('J. ticket cancelado: materialize e backfill ignoram; preview separa', () => {
  assert.match(materialize, /t\.status not in \('cancelled', 'canceled', 'void', 'voided'\)/);
  assert.match(backfill, /t\.status not in \('cancelled', 'canceled', 'void', 'voided'\)/);
  assert.match(preview, /operational boolean/);
  assert.match(preview, /\(t\.status not in \('cancelled', 'canceled', 'void', 'voided'\)\)/);
});

test('K. materializacao repetida e idempotente', () => {
  assert.match(materialize, /and t\.owner_user_id is null/);
  assert.match(claim, /if v_inv\.status = 'claimed' then[\s\S]*reconcile_registration_contact_account/);
});

test('historico e materializacao inicial, nao transferencia', () => {
  assert.match(materialize, /'owner_assigned', null, p_user_id/);
  assert.match(materialize, /intended_owner_materialized/);
  assert.doesNotMatch(materialize, /owner_transferred/);
  assert.match(reasons, /intended_owner_materialized/);
  assert.match(reasons, /Materialização do proprietário pretendido/);
});

test('intended_owner nao e sinonimo de titular no copy trigger', () => {
  assert.match(copyIntended, /select oi\.intended_owner_contact_id/);
  assert.doesNotMatch(copyIntended, /oi\.registration_contact_id/);
  assert.doesNotMatch(copyIntended, /coalesce\(oi\.intended_owner_contact_id, oi\.registration_contact_id\)/);
});

test('backfill reutiliza a RPC canonica e a migration nao muta producao', () => {
  assert.match(backfill, /materialize_intended_ticket_owners_for_contact\(v_row\.contact_id, v_row\.user_id\)/);
  assert.doesNotMatch(canonical, /select public\.reconcile_intended_ticket_owners_for_linked_contacts\(\)/);
  assert.doesNotMatch(canonical, /2fda29b0-ab3c-4972-b48a-74819ab249b6|ae59615e-fd3b-4606-b317-b679d246653e|08c245d2-cac2-4ef1-9098-35e9dd6e7897/);
});

test('Minha Conta permanece exclusivamente por owner_user_id', () => {
  assert.match(portal, /\.eq\('owner_user_id', userId\)/);
  assert.doesNotMatch(portal, /intended_owner_contact_id', userId/);
  assert.doesNotMatch(portal, /participants!inner\(user_id\)/);
  assert.doesNotMatch(portal, /\.eq\('cpf'/);
  assert.doesNotMatch(portal, /\.eq\('email'/);
});

test('UI apos materializacao: Ana/Barbara com owner, pretendido some', () => {
  assert.match(identityUi, /ticketIntendedOwnerDisplayName/);
  const after = buildTicketIdentityView({
    holderName: 'Ana Luiza Schapanski',
    holderContactUserId: 'auth-ana',
    ownerUserId: 'auth-ana',
    ownerName: 'Ana Luiza Schapanski',
    intendedOwnerContactId: 'cadastro-ana',
    intendedOwnerName: 'Ana Luiza Schapanski',
  });
  assert.equal(after.holderAccountLabel, 'Ativa');
  assert.equal(after.ownerName, 'Ana Luiza Schapanski');
  assert.equal(after.intendedOwnerName, null);
  const pending = buildTicketIdentityView({
    holderName: 'João da Silva',
    holderContactUserId: null,
    ownerUserId: null,
    intendedOwnerContactId: 'cadastro-joao',
    intendedOwnerName: 'João da Silva',
  });
  assert.equal(pending.ownerName, 'Não definido');
  assert.equal(pending.intendedOwnerName, 'João da Silva');
});
