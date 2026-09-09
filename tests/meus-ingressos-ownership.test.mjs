import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20261009000000_linked_account_ticket_ownership.sql', import.meta.url), 'utf8');
const portal = await readFile(new URL('../src/lib/account/portal-orders-and-tickets.ts', import.meta.url), 'utf8');
const listPage = await readFile(new URL('../src/app/minha-conta/ingressos/page.tsx', import.meta.url), 'utf8');
const detailPage = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
const firstAccess = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
const firstAccessValidation = await readFile(new URL('../src/lib/account/first-access-validation.ts', import.meta.url), 'utf8');
const paymentStatus = await readFile(new URL('../supabase/migrations/20260950000000_ticket_owner_payment_operational_status.sql', import.meta.url), 'utf8');
const holderFn = await readFile(new URL('../supabase/migrations/20260815001914_remote_schema.sql', import.meta.url), 'utf8');
const transferSql = holderFn.slice(
  holderFn.indexOf('CREATE OR REPLACE FUNCTION "public"."admin_transfer_ticket_ownership"'),
  holderFn.indexOf('ALTER FUNCTION "public"."admin_transfer_ticket_ownership"'),
);
const setHolderSql = holderFn.slice(
  holderFn.indexOf('CREATE OR REPLACE FUNCTION "public"."admin_set_ticket_holder_contact"("p_ticket_id" "uuid", "p_registration_contact_id" "uuid", "p_reason_code" "text"'),
  holderFn.indexOf('ALTER FUNCTION "public"."admin_set_ticket_holder_contact"("p_ticket_id" "uuid", "p_registration_contact_id" "uuid", "p_reason_code" "text"'),
);
const resolveFn = migration.slice(
  migration.indexOf('create or replace function public.resolve_administrative_ticket_owner'),
  migration.indexOf('create or replace function public.trg_initialize_ticket_owner'),
);
const issueFn = migration.slice(
  migration.indexOf('create or replace function public.issue_manual_ticket_batch'),
  migration.indexOf('create or replace function public.claim_registration_contact_account_invite'),
);
const claimFn = migration.slice(
  migration.indexOf('create or replace function public.claim_registration_contact_account_invite'),
  migration.indexOf('-- Reparo estrutural'),
);

test('T1 emissao administrativa para Pessoa com conta usa registration_contacts.user_id', () => {
  assert.match(resolveFn, /from public\.registration_contacts c\s+join auth\.users au on au\.id = c\.user_id/);
  assert.match(resolveFn, /c\.id = p_registration_contact_id/);
  assert.doesNotMatch(resolveFn, /lower\(trim\(.*email/);
  assert.doesNotMatch(resolveFn, /auth\.users.*email/);
  assert.match(issueFn, /v_owner_user_id := public\.resolve_administrative_ticket_owner/);
  assert.match(issueFn, /materialize_intended_ticket_owners_for_contact\(v_contact\.id, v_contact\.user_id\)/);
  assert.match(issueFn, /intended_owner_contact_id = coalesce\(intended_owner_contact_id, v_contact\.id\)/);
  assert.match(portal, /\.eq\('owner_user_id', userId\)/);
  assert.match(listPage, /getAccessibleTicketScope/);
});

test('T2 Pessoa sem conta permanece owner null ate o claim seguro', () => {
  assert.match(resolveFn, /if v_owner is null then\s+return null;/);
  assert.match(migration, /Se ainda não tem conta, permanece pendente de claim seguro/);
  assert.match(claimFn, /perform public\.materialize_intended_ticket_owners_for_contact\(v_contact\.id, v_actor\)/);
  assert.match(claimFn, /perform public\.reconcile_registration_contact_account\(v_contact\.id, v_actor\)/);
  assert.match(firstAccess, /claim_registration_contact_account_invite/);
  assert.match(firstAccess, /reconcile_imported_ticket_issuance_for_user/);
});

test('T3 primeiro acesso importado materializa ownership sem botao extra', () => {
  assert.match(firstAccess, /inviteContext\?\.anchorKind === 'contact'/);
  assert.match(firstAccess, /reconcile_imported_ticket_issuance_for_user/);
  assert.doesNotMatch(firstAccess, /reivindicar ingresso|claim ticket|vincular ingresso/i);
  assert.match(claimFn, /set user_id = v_actor/);
});

test('T4 e-mail compartilhado nao atribui ticket da Pessoa B para a conta A', () => {
  const materializeFn = migration.slice(
    migration.indexOf('create or replace function public.materialize_intended_ticket_owners_for_contact'),
    migration.indexOf('create or replace function public.trg_materialize_linked_ticket_owner'),
  );
  assert.doesNotMatch(resolveFn, /registration_contacts\.email/);
  assert.doesNotMatch(resolveFn, /lower\(trim\(coalesce\(c\.email/);
  assert.match(materializeFn, /where t\.intended_owner_contact_id = p_contact_id/);
  assert.doesNotMatch(materializeFn, /email/);
});

test('T5 CPF pendente nao vira match e nao entrega ingresso', () => {
  assert.doesNotMatch(resolveFn, /cpf/);
  assert.match(firstAccessValidation, /isValidCpf\(values\.cpf\)/);
  assert.match(firstAccessValidation, /Informe um CPF válido/);
});

test('T6 CPF validado no primeiro acesso segue para claim e ownership', () => {
  const claimAt = firstAccess.indexOf("rpc('claim_registration_contact_account_invite'");
  const cpfValidateAt = firstAccess.indexOf('validateFirstAccessProfile');
  const reconcileAt = firstAccess.indexOf("rpc('reconcile_imported_ticket_issuance_for_user'");
  assert.ok(cpfValidateAt >= 0 && claimAt > cpfValidateAt);
  assert.ok(reconcileAt > claimAt);
  assert.match(claimFn, /materialize_intended_ticket_owners_for_contact\(v_contact\.id, v_actor\)/);
});

test('T7 transferencia administrativa troca somente owner_user_id', () => {
  assert.match(transferSql, /update public\.tickets set owner_user_id=p_new_owner_user_id/);
  assert.match(transferSql, /ticket_owner_history/);
  assert.match(portal, /\.eq\('owner_user_id', userId\)/);
});

test('T8 remocao de titular nao apaga ownership', () => {
  const removeBlock = setHolderSql.slice(setHolderSql.indexOf('if p_registration_contact_id is null then'), setHolderSql.indexOf('select * into v_contact'));
  assert.match(removeBlock, /update public\.tickets set participant_id=null/);
  assert.doesNotMatch(removeBlock, /owner_user_id/);
  assert.match(removeBlock, /holder_removed/);
});

test('T9 cortesia nao e filtro de Meus ingressos', () => {
  assert.doesNotMatch(portal, /payment_method.*courtesy|courtesy.*payment_method/);
  assert.match(listPage, /getAccessibleTicketScope/);
  assert.match(paymentStatus, /where t\.owner_user_id = v_actor/);
  assert.match(issueFn, /v_financial_method constant text := 'courtesy'/);
});

test('T10 legado unknown nao exige pagamento LIVE para aparecer', () => {
  assert.match(listPage, /orderStatus === 'confirmed'/);
  assert.doesNotMatch(listPage, /asaas|LIVE|price_origin/);
  assert.match(detailPage, /orderStatus === 'confirmed'/);
  assert.doesNotMatch(detailPage, /price_origin.*legacy_unknown/);
  assert.match(paymentStatus, /cortesia\/import confirmado/);
});

test('portal continua na fonte canonica tickets.owner_user_id', () => {
  assert.match(portal, /from\('tickets'\)/);
  assert.match(portal, /\.eq\('owner_user_id', userId\)/);
  assert.doesNotMatch(portal, /participants!inner\(user_id\)/);
  assert.match(detailPage, /const isOwner/);
  assert.match(detailPage, /ticket\.owner_user_id/);
});

test('reparo estrutural nao recria pedido pagamento nem ingresso', () => {
  const repair = migration.slice(migration.indexOf('-- Reparo estrutural'));
  assert.match(repair, /materialize_intended_ticket_owners_for_contact/);
  assert.match(repair, /reconcile_registration_contact_account/);
  assert.doesNotMatch(repair, /insert into public\.(orders|payments|tickets|order_items)/);
  assert.doesNotMatch(repair, /delete from public\.(orders|payments|tickets)/);
  assert.match(migration, /20261009000000/);
  assert.doesNotMatch(migration, /20261008000000_legacy_import_ticket_vs_cadastral/);
});
