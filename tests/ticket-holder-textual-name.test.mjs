import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildAdminClearTicketHolderNamePayload,
  buildAdminSetTicketHolderNamePayload,
} from '../src/lib/admin/ticket-holder-rpc.ts';
import { canonicalHolderName, hasCanonicalHolderName } from '../src/lib/tickets/holder-name.ts';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const ticket = 'dec6d451-27c1-423d-8ac1-657ee8b0feb9';

test('helper canonico prioriza holder_full_name e trata vazio como sem titular', () => {
  assert.equal(canonicalHolderName(' João ', 'Douglas'), 'João');
  assert.equal(canonicalHolderName('', 'Douglas'), 'Douglas');
  assert.equal(canonicalHolderName(null, null), 'Titular não definido');
  assert.equal(hasCanonicalHolderName(' João '), true);
  assert.equal(hasCanonicalHolderName('  '), false);
});

test('payload admin de nome rejeita vazio e nao envia cadastro', () => {
  assert.deepEqual(buildAdminSetTicketHolderNamePayload(ticket, '  João  '), {
    p_ticket_id: ticket,
    p_holder_name: 'João',
    p_reason_code: 'administrative_adjustment',
    p_reason_text: null,
  });
  assert.throws(() => buildAdminSetTicketHolderNamePayload(ticket, '   '), /Informe o nome do titular/);
  const payload = buildAdminSetTicketHolderNamePayload(ticket, 'Maria');
  assert.equal('p_registration_contact_id' in payload, false);
});

test('payload de remocao envia null explicito com motivo', () => {
  assert.deepEqual(buildAdminClearTicketHolderNamePayload(ticket, 'buyer_request'), {
    p_ticket_id: ticket,
    p_holder_name: null,
    p_reason_code: 'buyer_request',
    p_reason_text: null,
  });
});

test('migration aditiva cria RPC textual, backfill e colunas de historico sem dropar legado', async () => {
  const sql = await read('../supabase/migrations/20261028000000_ticket_holder_textual_name.sql');
  assert.match(sql, /add column if not exists previous_holder_name text/);
  assert.match(sql, /add column if not exists new_holder_name text/);
  assert.match(sql, /admin_set_ticket_holder_name/);
  assert.match(sql, /set_ticket_holder_name_for_owner/);
  assert.match(sql, /holder_full_name = src\.resolved_name/);
  assert.match(sql, /and nullif\(trim\(coalesce\(oi\.holder_full_name, ''\)\), ''\) is null/);
  assert.match(sql, /update public\.tickets\s+set participant_id = null/s);
  assert.doesNotMatch(sql, /update public\.tickets[\s\S]{0,80}owner_user_id\s*=/);
  assert.doesNotMatch(sql, /update public\.orders/);
  const holderWrite = sql.slice(
    sql.indexOf('create or replace function public.apply_ticket_holder_name_internal'),
    sql.indexOf('create or replace function public.list_admin_tickets'),
  );
  assert.doesNotMatch(holderWrite, /insert into public\.registration_contacts/);
  assert.doesNotMatch(holderWrite, /insert into public\.participants/);
  assert.doesNotMatch(sql, /assert_ticket_holder_contact_available/);
  assert.match(sql, /nullif\(trim\(oi\.holder_full_name\), ''\) is not null\) as has_holder/);
  assert.match(sql, /v_titularidade = 'com' and nullif\(trim\(oi\.holder_full_name\), ''\) is not null/);
  assert.doesNotMatch(sql, /drop table/i);
  assert.doesNotMatch(sql, /drop function public\.admin_set_ticket_holder_contact/);
  assert.doesNotMatch(sql, /drop function public\.admin_transfer_ticket_ownership/);
});

test('RPC textual nunca cria identidade e nunca altera owner', async () => {
  const sql = await read('../supabase/migrations/20261028000000_ticket_holder_textual_name.sql');
  const fn = sql.slice(
    sql.indexOf('create or replace function public.apply_ticket_holder_name_internal'),
    sql.indexOf('create or replace function public.admin_set_ticket_holder_name'),
  );
  assert.match(fn, /holder_full_name = v_name/);
  assert.match(fn, /participant_id = null/);
  assert.match(fn, /registration_contact_id = null/);
  assert.match(fn, /previous_holder_name, new_holder_name/);
  assert.match(fn, /owner_user_id is not distinct from v_owner_user_id/);
  assert.doesNotMatch(fn, /insert into public\.registration_contacts/);
  assert.doesNotMatch(fn, /insert into public\.participants/);
  assert.doesNotMatch(fn, /assert_ticket_holder_contact_available/);
  assert.doesNotMatch(fn, /HOLDER_ALREADY_HAS_TICKET_FOR_EVENT/);
  assert.doesNotMatch(fn, /set owner_user_id/);
  assert.doesNotMatch(fn, /update public\.orders/);
});

test('admin UI deixa de pesquisar Cadastro e separa propriedade', async () => {
  const [editor, actions] = await Promise.all([
    read('../src/app/ingressos/[ticketId]/editar/ticket-ownership-editor.tsx'),
    read('../src/app/ingressos/[ticketId]/editar/actions.ts'),
  ]);
  assert.match(editor, /Alterar titular/);
  assert.match(editor, /Nome do titular/);
  assert.match(editor, /Nome usado para identificar quem utilizará este pacote/);
  assert.match(editor, /Salvar titular/);
  assert.match(editor, /Transferir propriedade/);
  assert.match(editor, /Muda a conta que controla o ingresso/);
  assert.match(editor, /Remover titular/);
  assert.match(editor, /clearTicketHolderNameAction/);
  assert.match(editor, /setTicketHolderNameAction/);
  assert.doesNotMatch(editor, /searchTicketHolderCandidatesAction/);
  assert.doesNotMatch(editor, /Nome, e-mail, CPF ou PIN/);
  assert.doesNotMatch(editor, /search_admin_ticket_holder_contacts/);
  assert.match(actions, /admin_set_ticket_holder_name/);
  assert.doesNotMatch(actions, /admin_set_ticket_holder_contact/);
  assert.doesNotMatch(actions, /search_admin_ticket_holder_contacts/);
  assert.match(actions, /admin_transfer_ticket_ownership/);
});

test('Minha Conta usa nome livre e nao PIN para titular', async () => {
  const [holderUi, page, actions] = await Promise.all([
    read('../src/app/minha-conta/ingressos/[ticketId]/ticket-holder-actions.tsx'),
    read('../src/app/minha-conta/ingressos/[ticketId]/page.tsx'),
    read('../src/app/minha-conta/actions.ts'),
  ]);
  assert.match(holderUi, /Nome do titular/);
  assert.match(holderUi, /setOwnerTicketHolderNameAction/);
  assert.doesNotMatch(holderUi, /findUserByPinAction|defineTicketHolderByPinAction|transferTicketByPinAction/);
  assert.doesNotMatch(holderUi, /Código do ingresso/);
  assert.match(page, /hasCanonicalHolderName/);
  assert.match(page, /canManageOperationalFlow \?/);
  assert.doesNotMatch(page, /participantId && canManageOperationalFlow/);
  assert.match(actions, /set_ticket_holder_name_for_owner/);
});

test('leitura operacional prioriza holder_full_name', async () => {
  const [turbo, dashboard, list, timeline] = await Promise.all([
    read('../src/app/operacoes/actions.ts'),
    read('../src/lib/dashboard/admin-dashboard-data.ts'),
    read('../src/app/minha-conta/ingressos/page.tsx'),
    read('../src/lib/admin/ticket-timeline.ts'),
  ]);
  assert.match(turbo, /canonicalHolderName\(/);
  assert.match(turbo, /getOperationTicketViewAction[\s\S]{0,1800}canonicalHolderName\(/);
  assert.match(dashboard, /canonicalHolderName\(/);
  assert.doesNotMatch(dashboard, /Titular informado sem dados suficientes para identificação/);
  assert.doesNotMatch(dashboard, /textualHolderOnly/);
  assert.match(list, /canonicalHolderName\(item\.holder_full_name/);
  assert.match(timeline, /previous_holder_name/);
  assert.match(timeline, /canonicalHolderName\(orderItem\?\.holder_full_name/);
});

test('checkout nomeado futuro grava so o nome e nao cria identidade', async () => {
  const [sql, wizard] = await Promise.all([
    read('../supabase/migrations/20261030000000_named_checkout_textual_holder_only.sql'),
    read('../src/app/inscricao/[eventSlug]/wizard.tsx'),
  ]);
  const named = sql.slice(sql.indexOf('create or replace function public.materialize_named_checkout_holders'));
  assert.match(named, /named_ticket_holder_textual/);
  assert.match(named, /ownership_status = case when v_name is null then 'unassigned' else 'assigned' end/);
  assert.match(named, /ignored_identity_fields/);
  assert.doesNotMatch(named, /insert into public\.registration_contacts/);
  assert.doesNotMatch(named, /insert into public\.participants/);
  assert.doesNotMatch(named, /v_has_reliable_identity/);
  assert.doesNotMatch(named, /assert_ticket_holder_contact_available/);
  assert.match(wizard, /O nome identifica o titular deste pacote/);
  assert.doesNotMatch(wizard, /CPF do titular/);
});
