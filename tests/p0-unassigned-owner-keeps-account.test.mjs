import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const OFFICIAL_BATCH = 'aee74ffb-1eb3-4742-818f-77b701fd7da0';
const LEONARDO_USER = 'cee47839-827b-4c57-8778-490b1f7c5faa';
const LEONARDO_CONTACT = 'c9f8e828-c7ef-4592-ac90-9b844e0f2dd5';
const FIRST_TICKET = 'f759feb1-5c7e-4f2a-899e-c76a0053b5a7';
const ORPHAN_A = 'ad6f3bcd-caee-4b47-8d48-0dce27d04672';
const ORPHAN_B = 'e4fb3203-af43-4d1d-b6e0-94bfcebc326c';
const ORDER_1612 = 'bfa58cb7-c9ac-4a16-9115-0a32fca5724f';

const migration = await readFile(new URL('../supabase/migrations/20261018000000_unassigned_manual_ticket_keeps_owner.sql', import.meta.url), 'utf8');
const previousIssue = await readFile(new URL('../supabase/migrations/20261009000000_linked_account_ticket_ownership.sql', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/ingressos/emitir/actions.ts', import.meta.url), 'utf8');
const form = await readFile(new URL('../src/app/ingressos/emitir/issue-ticket-form.tsx', import.meta.url), 'utf8');
const portal = await readFile(new URL('../src/lib/account/portal-orders-and-tickets.ts', import.meta.url), 'utf8');
const listPage = await readFile(new URL('../src/app/minha-conta/ingressos/page.tsx', import.meta.url), 'utf8');
const detailPage = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
const confirmAction = await readFile(new URL('../src/app/inscricoes/actions.ts', import.meta.url), 'utf8');
const uniqueness = await readFile(new URL('../src/lib/registrations/active-ticket-holder.ts', import.meta.url), 'utf8');

const issueFn = migration.slice(
  migration.indexOf('create or replace function public.issue_manual_ticket_batch'),
  migration.indexOf('revoke all on function public.issue_manual_ticket_batch'),
);
const unassignedLoop = issueFn.slice(issueFn.indexOf('for v_index in v_index..p_quantity loop'));
const backfill = migration.slice(migration.indexOf('with repaired as'));

test('1-3. mesmo owner recebe segundo ingresso sem holder e aparece na Minha Conta', () => {
  assert.match(issueFn, /v_owner_user_id := public\.resolve_administrative_ticket_owner/);
  assert.match(unassignedLoop, /intended_owner_contact_id = v_contact\.id/);
  assert.match(unassignedLoop, /set\s+owner_user_id = v_owner_user_id/);
  assert.doesNotMatch(unassignedLoop, /owner_user_id = null/);
  assert.match(portal, /\.eq\('owner_user_id', userId\)/);
  assert.match(listPage, /Não definido/);
  assert.match(detailPage, /Não definido/);
  assert.match(actions, /holderLabel/);
});

test('4-5. owner_user_id da conta de destino e holder NULL', () => {
  assert.match(unassignedLoop, /and participant_id is null/);
  assert.doesNotMatch(unassignedLoop, /set participant_id/);
  assert.match(actions, /if \(row\.participant_id\) return true/);
  assert.match(actions, /destinationUserId && owner !== destinationUserId/);
  assert.match(backfill, new RegExp(LEONARDO_USER));
  assert.match(backfill, /t\.participant_id is null/);
});

test('6. QR continua no token existente, sem reemitir', () => {
  assert.doesNotMatch(backfill, /insert into public\.tickets/);
  assert.doesNotMatch(backfill, /update public\.tickets[\s\S]*token/);
  assert.match(listPage, /ticket\?\.token/);
  assert.match(detailPage, /ticket\.token/);
});

test('7-8. unicidade e de titular, nao de owner', () => {
  assert.match(actions, /registrationContactHasActiveTicket/);
  assert.match(actions, /requiresHolderDecision: true/);
  assert.match(uniqueness, /registrationContactHasActiveTicket/);
  assert.match(issueFn, /if coalesce\(p_assign_holder, true\) then[\s\S]*assert_ticket_holder_contact_available/);
  assert.doesNotMatch(unassignedLoop, /assert_ticket_holder_contact_available/);
});

test('9-11. emissao sem titular nao cria Pessoa/Auth e nao altera o primeiro ticket', () => {
  assert.doesNotMatch(unassignedLoop, /insert into public\.registration_contacts/);
  assert.doesNotMatch(unassignedLoop, /insert into auth\.users/);
  assert.doesNotMatch(backfill, new RegExp(FIRST_TICKET));
  assert.match(backfill, new RegExp(ORPHAN_A));
  assert.match(backfill, new RegExp(ORPHAN_B));
  assert.doesNotMatch(previousIssue.slice(previousIssue.indexOf('for v_index in v_index..p_quantity loop')), /owner_user_id = v_owner_user_id/);
});

test('12-14. cortesia nao falsifica PIX e pending PIX continua pending', () => {
  assert.match(issueFn, /v_financial_method constant text := 'courtesy'/);
  assert.doesNotMatch(backfill, /payment_status = 'paid'/);
  assert.doesNotMatch(backfill, new RegExp(ORDER_1612));
  assert.doesNotMatch(backfill, /asaas|payment_gateway_charges/i);
  assert.doesNotMatch(migration, new RegExp(OFFICIAL_BATCH));
  const confirmFn = confirmAction.slice(confirmAction.indexOf('export async function confirmParticipantPaymentAction'));
  assert.match(confirmFn, /Este PIX não possui cobrança no gateway/);
  assert.match(confirmFn, /use Emitir ingresso/);
});

test('15. UI nao apresenta falso sucesso', () => {
  assert.match(actions, /A emissão não persistiu todos os ingressos esperados/);
  assert.match(actions, /O ingresso não ficou com o proprietário da conta de destino/);
  assert.match(form, /whitespace-pre-line/);
  assert.match(form, /Proprietário|ownerName|result\.message/);
  assert.match(form, /Abrir ingresso/);
  assert.match(backfill, /unassigned_manual_ticket_owner_repaired/);
  assert.match(backfill, new RegExp(LEONARDO_CONTACT));
});
