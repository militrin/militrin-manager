import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildTicketIdentityView, contactTicketRoleLabel, rolesForContactTicket } from '../src/lib/registrations/contact-tickets.ts';

const JORDAN_CONTACT = 'c9b808e2-c7c1-4d5d-bef5-5e56d6b20cbe';
const JORDAN_TICKET = '436380d8-3d70-4c49-b12e-aee22b59fdb4';
const ROBERTO_CANCELLED = 'af7c4988-0076-4d05-9e55-a164d5031b23';
const LEONARDO_CONTACT = 'c9f8e828-c7ef-4592-ac90-9b844e0f2dd5';

const migration = await readFile(new URL('../supabase/migrations/20261020000000_ownership_cycle_intended_owner_guard.sql', import.meta.url), 'utf8');
const claimSql = await readFile(new URL('../supabase/migrations/20261009000000_linked_account_ticket_ownership.sql', import.meta.url), 'utf8');
const claimHotfixSql = await readFile(new URL('../supabase/migrations/20261105000000_first_access_reissue_correlation.sql', import.meta.url), 'utf8');
const canonicalSql = await readFile(new URL('../supabase/migrations/20261106000000_canonical_ticket_ownership_invariant.sql', import.meta.url), 'utf8');
const firstAccess = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
const portal = await readFile(new URL('../src/lib/account/portal-orders-and-tickets.ts', import.meta.url), 'utf8');
const cadastroPage = await readFile(new URL('../src/app/cadastros/[id]/page.tsx', import.meta.url), 'utf8');
const adminTicket = await readFile(new URL('../src/app/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
const ownerCard = await readFile(new URL('../src/app/ingressos/[ticketId]/change-ticket-account-owner.tsx', import.meta.url), 'utf8');
const confirmSql = await readFile(new URL('../supabase/migrations/20260957000000_legacy_import_unknown_price.sql', import.meta.url), 'utf8');

const issueFn = migration.slice(
  migration.indexOf('create or replace function public.issue_manual_ticket_batch'),
  migration.indexOf('revoke all on function public.issue_manual_ticket_batch'),
);
const holderPath = issueFn.slice(
  issueFn.indexOf('if coalesce(p_assign_holder, true) then'),
  issueFn.indexOf('else') > 0 ? issueFn.indexOf('v_index := 1') : issueFn.length,
);
const unassignedLoop = issueFn.slice(issueFn.indexOf('for v_index in v_index..p_quantity loop'));
const initFn = migration.slice(
  migration.indexOf('create or replace function public.trg_initialize_ticket_owner'),
  migration.indexOf('create or replace function public.trg_materialize_linked_ticket_owner'),
);
const materializeTrigger = migration.slice(
  migration.indexOf('create or replace function public.trg_materialize_linked_ticket_owner'),
  migration.indexOf('create or replace function public.issue_manual_ticket_batch'),
);
const claimHotfixFn = claimHotfixSql.slice(
  claimHotfixSql.indexOf('create or replace function public.claim_registration_contact_account_invite'),
  claimHotfixSql.indexOf('\n$$;', claimHotfixSql.indexOf('create or replace function public.claim_registration_contact_account_invite')),
);
const canonicalClaimFn = canonicalSql.slice(
  canonicalSql.indexOf('create or replace function public.claim_registration_contact_account_invite'),
  canonicalSql.indexOf('\n$$;', canonicalSql.indexOf('create or replace function public.claim_registration_contact_account_invite')),
);
const canonicalInitFn = canonicalSql.slice(
  canonicalSql.indexOf('create or replace function public.trg_initialize_ticket_owner'),
  canonicalSql.indexOf('create or replace function public.trg_zz_ticket_ownership_invariant'),
);
const canonicalMaterializeFn = canonicalSql.slice(
  canonicalSql.indexOf('create or replace function public.materialize_intended_ticket_owners_for_contact'),
  canonicalSql.indexOf('create or replace function public.trg_ticket_copy_intended_owner'),
);
const canonicalCopyFn = canonicalSql.slice(
  canonicalSql.indexOf('create or replace function public.trg_ticket_copy_intended_owner'),
  canonicalSql.indexOf('create or replace function public.trg_initialize_ticket_owner'),
);
const canonicalReconcileFn = canonicalSql.slice(
  canonicalSql.indexOf('create or replace function public.reconcile_registration_contact_account'),
  canonicalSql.indexOf('create or replace function public.claim_registration_contact_account_invite'),
);
const resolveFn = claimSql.slice(
  claimSql.indexOf('create or replace function public.resolve_administrative_ticket_owner'),
  claimSql.indexOf('create or replace function public.trg_initialize_ticket_owner'),
);
const confirmFn = confirmSql.slice(
  confirmSql.indexOf('create or replace function public.confirm_order_item_and_issue_ticket'),
  confirmSql.indexOf('create or replace function public.finalize_imported_ticket_after_issue_resolution'),
);

test('1. Pessoa com Auth + emissao com titular: owner imediato via resolve, intended_owner obrigatorio', () => {
  assert.match(holderPath, /intended_owner_contact_id = v_contact\.id/);
  assert.match(holderPath, /v_contact\.user_id is not null then[\s\S]*materialize_intended_ticket_owners_for_contact\(v_contact\.id, v_contact\.user_id\)/);
  assert.match(holderPath, /v_owner_user_id := public\.resolve_administrative_ticket_owner/);
  assert.match(holderPath, /set owner_user_id = v_owner_user_id/);
  assert.match(holderPath, /assert_administrative_destination_ownership\(v_first\.ticket_id, v_contact\.id\)/);
  assert.match(portal, /\.eq\('owner_user_id', userId\)/);
});

test('2. Pessoa com Auth + emissao sem titular: owner imediato, holder permanece null', () => {
  assert.match(unassignedLoop, /intended_owner_contact_id = v_contact\.id/);
  assert.match(unassignedLoop, /set\s+owner_user_id = v_owner_user_id/);
  assert.match(unassignedLoop, /and participant_id is null/);
  assert.doesNotMatch(unassignedLoop, /owner_user_id = null/);
  assert.match(unassignedLoop, /assert_administrative_destination_ownership\(v_extra\.ticket_id, v_contact\.id\)/);
});

test('3-4. Pessoa sem Auth: intended_owner preenchido e owner NULL na emissao', () => {
  assert.match(resolveFn, /if v_owner is null then\s+return null;/);
  assert.match(holderPath, /if v_contact\.user_id is not null then/);
  assert.match(initFn, /buyer_type in \('administrative', 'imported_holder'\)/);
  assert.match(initFn, /new\.intended_owner_contact_id := v_registration_contact_id/);
  assert.doesNotMatch(initFn, /lower\(trim\(.*email/);
});

test('5-6. primeiro acesso materializa so por intended_owner; nunca e-mail/CPF/holder', () => {
  assert.match(firstAccess, /claim_registration_contact_account_invite/);
  assert.match(claimHotfixFn, /skip_ticket_ownership_on_account_claim/);
  assert.doesNotMatch(canonicalClaimFn, /skip_ticket_ownership_on_account_claim/);
  assert.match(canonicalClaimFn, /update public\.registration_contacts\s+set user_id = v_actor/);
  assert.match(canonicalClaimFn, /reconcile_registration_contact_account\(v_contact\.id, v_actor\)/);
  assert.doesNotMatch(canonicalClaimFn, /materialize_intended_ticket_owners_for_contact\(v_contact\.id, v_actor\)/);
  assert.doesNotMatch(canonicalClaimFn, /update public\.tickets/);
  assert.doesNotMatch(canonicalClaimFn, /lower\(trim\(.*email[\s\S]*tickets/);
  assert.match(canonicalMaterializeFn, /where t\.intended_owner_contact_id = p_contact_id\s+and t\.owner_user_id is null/);
  assert.match(canonicalMaterializeFn, /c\.user_id = p_user_id/);
  assert.doesNotMatch(canonicalMaterializeFn, /email|cpf|holder_full_name|participant_id|order_items/i);
  assert.doesNotMatch(canonicalReconcileFn, /exists \(\s+select 1 from public\.participants as holder/);
  assert.doesNotMatch(canonicalReconcileFn, /item\.registration_contact_id = v_contact\.id/);
});

test('7-9. varios tickets, holders diferentes ou NULL nao alteram a regra de owner', () => {
  assert.match(unassignedLoop, /intended_owner_contact_id = v_contact\.id/);
  assert.match(holderPath, /assert_ticket_holder_contact_available/);
  assert.doesNotMatch(unassignedLoop, /assert_ticket_holder_contact_available/);
  assert.match(portal, /\.eq\('owner_user_id', userId\)/);
  assert.doesNotMatch(portal, /participants!inner\(user_id\)/);
  assert.doesNotMatch(portal, /\.eq\('email'/);
});

test('10-11. shared-email e matching oportunista por e-mail continuam proibidos', () => {
  assert.doesNotMatch(resolveFn, /registration_contacts\.email/);
  assert.doesNotMatch(issueFn, /auth\.users.*email|lower\(trim\(coalesce\(v_contact\.email/);
  assert.match(resolveFn, /from public\.registration_contacts c\s+join auth\.users au on au\.id = c\.user_id/);
});

test('12. retry de claim e idempotente e materializa so intended null-owner', () => {
  assert.match(canonicalClaimFn, /if v_inv\.status = 'claimed' then[\s\S]*reconcile_registration_contact_account\(v_contact\.id, v_actor\)[\s\S]*return v_contact\.id;/);
  assert.doesNotMatch(canonicalClaimFn, /skip_ticket_ownership_on_account_claim/);
  assert.match(canonicalMaterializeFn, /and t\.owner_user_id is null/);
  assert.match(canonicalMaterializeFn, /'owner_assigned', null, p_user_id/);
});

test('13. retry de emissao do mesmo order_item nao duplica ticket', () => {
  assert.match(confirmFn, /on conflict\(order_item_id\) where order_item_id is not null/);
  assert.match(holderPath, /assert_ticket_holder_contact_available/);
});

test('guardrail: destinario conhecido nunca termina sem intended_owner', () => {
  assert.match(migration, /ADMINISTRATIVE_TICKET_REQUIRES_INTENDED_OWNER/);
  assert.match(issueFn, /assert_administrative_destination_ownership/);
  assert.match(materializeTrigger, /after insert or update of intended_owner_contact_id/);
  assert.match(materializeTrigger, /if pg_trigger_depth\(\) > 1 then return new;/);
});

test('checkout autenticado nasce do comprador; intended nao copia titular', () => {
  const accountAt = canonicalInitFn.indexOf("if v_order.buyer_type = 'account' then");
  const importedAt = canonicalInitFn.indexOf('if v_is_imported then');
  assert.ok(accountAt >= 0 && importedAt > accountAt, 'account buyer precisa vir antes da heuristica de importacao');
  assert.match(canonicalInitFn, /new\.owner_user_id := v_order\.user_id;/);
  assert.match(canonicalCopyFn, /select oi\.intended_owner_contact_id/);
  assert.doesNotMatch(canonicalCopyFn, /oi\.registration_contact_id/);
  assert.doesNotMatch(canonicalInitFn, /participation_history/);
});

test('Minha Conta continua canonica por owner_user_id', () => {
  assert.match(portal, /\.eq\('owner_user_id', userId\)/);
  assert.doesNotMatch(portal, /\.eq\('cpf'/);
  assert.doesNotMatch(portal, /intended_owner_contact_id', userId/);
});

test('ficha administrativa separa titular, conta do titular e proprietario', () => {
  assert.match(cadastroPage, /buildTicketIdentityView/);
  assert.match(cadastroPage, /TicketIdentitySummary/);
  assert.match(cadastroPage, /intended_owner_contact_id/);
  assert.doesNotMatch(cadastroPage, /ticketAwaitsFirstAccess|awaitingFirstAccess/);
  assert.doesNotMatch(cadastroPage, /Titular · aguardando primeiro acesso/);
  assert.match(adminTicket, /buildTicketIdentityView/);
  assert.match(adminTicket, /holderContactUserId/);
  assert.doesNotMatch(adminTicket, /awaitingFirstAccess/);
  assert.doesNotMatch(adminTicket, /!data\.owner_user_id && Boolean\(/);
  assert.match(ownerCard, /TicketIdentitySummary/);
  assert.match(ownerCard, /Conta do titular/);
  assert.doesNotMatch(ownerCard, /awaitingFirstAccess/);
  assert.deepEqual(rolesForContactTicket({
    ticketId: 't', eventId: 'e', eventName: 'Evento', ownerUserId: null,
    intendedOwnerContactId: 'jordan', orderItemContactId: null, participantContactId: null,
  }, 'jordan', []), ['intended_owner']);
  assert.equal(contactTicketRoleLabel(['intended_owner']), 'Pretendido');
  const claimedWithNullOwner = buildTicketIdentityView({
    holderName: 'Jordan',
    holderContactUserId: 'auth-jordan',
    ownerUserId: null,
    intendedOwnerContactId: 'jordan',
    intendedOwnerName: 'Jordan',
  });
  assert.equal(claimedWithNullOwner.holderAccountLabel, 'Ativa');
  assert.equal(claimedWithNullOwner.ownerName, 'Não definido');
  assert.doesNotMatch(claimedWithNullOwner.holderAccountLabel, /aguardando/i);
});

test('reparo desta migration nao toca Jordan, Roberto nem Leonardo', () => {
  assert.doesNotMatch(migration, new RegExp(JORDAN_CONTACT));
  assert.doesNotMatch(migration, new RegExp(JORDAN_TICKET));
  assert.doesNotMatch(migration, new RegExp(ROBERTO_CANCELLED));
  assert.doesNotMatch(migration, new RegExp(LEONARDO_CONTACT));
  assert.doesNotMatch(migration, /update public\.tickets t\s+set\s+owner_user_id/);
  assert.doesNotMatch(canonicalSql, new RegExp(JORDAN_CONTACT));
  assert.doesNotMatch(canonicalSql, new RegExp(JORDAN_TICKET));
  assert.doesNotMatch(canonicalSql, /update public\.tickets t\s+set owner_user_id = p_user_id[\s\S]*perform public\.reconcile_intended/);
  assert.doesNotMatch(canonicalSql, /select public\.reconcile_intended_ticket_owners_for_linked_contacts\(\)/);
});
