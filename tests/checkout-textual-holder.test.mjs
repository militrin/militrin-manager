import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('checkout nomeado ignora CPF/e-mail/telefone e nao cria identidade', async () => {
  const sql = await read('../supabase/migrations/20261030000000_named_checkout_textual_holder_only.sql');
  const named = sql.slice(sql.indexOf('create or replace function public.materialize_named_checkout_holders'));
  const self = sql.slice(
    sql.indexOf('create or replace function public.materialize_self_checkout_holder'),
    sql.indexOf('create or replace function public.materialize_named_checkout_holders'),
  );
  assert.match(named, /Titular textual: ignora CPF/);
  assert.match(named, /participant_id = null/);
  assert.match(named, /registration_contact_id = null/);
  assert.doesNotMatch(named, /insert into public\.registration_contacts/);
  assert.doesNotMatch(named, /insert into public\.participants/);
  assert.doesNotMatch(named, /auth\.users/);
  assert.match(self, /insert into public\.registration_contacts/);
  assert.match(self, /holder_full_name=v_buyer_name/);
  assert.doesNotMatch(self, /insert into public\.participants/);
  assert.doesNotMatch(self, /intended_owner_contact_id/);
});

test('wizard de titular nomeado pede so o nome', async () => {
  const wizard = await read('../src/app/inscricao/[eventSlug]/wizard.tsx');
  assert.match(wizard, /placeholder="Nome do titular"/);
  assert.match(wizard, /Não cria Cadastro, conta nem transfere a propriedade/);
  assert.doesNotMatch(wizard, /CPF do titular/);
  assert.doesNotMatch(wizard, /holder_cpf: item\.ownershipMode === 'named'/);
});

test('compra para si preenche holder_full_name a partir da conta', async () => {
  const action = await read('../src/app/inscricao/actions.ts');
  assert.match(action, /holder_full_name: buyerFullName/);
  assert.match(action, /item\.ownership_mode === 'self'/);
});

test('observacao do ingresso e ticket-first e a cadastral permanece no Cadastro', async () => {
  const [sql, notesAction, ticketPage, inscricoesPage] = await Promise.all([
    read('../supabase/migrations/20261031000000_ticket_operational_notes.sql'),
    read('../src/app/minha-conta/actions.ts'),
    read('../src/app/minha-conta/ingressos/[ticketId]/page.tsx'),
    read('../src/app/inscricoes/[id]/page.tsx'),
  ]);
  assert.match(sql, /add column if not exists operational_notes text/);
  assert.match(sql, /update_ticket_operational_notes/);
  assert.match(sql, /t\.operational_notes is null/);
  assert.doesNotMatch(sql, /update public\.participants set notes/);
  assert.match(notesAction, /update_ticket_operational_notes/);
  assert.doesNotMatch(notesAction, /Titular ainda nao definido/);
  assert.doesNotMatch(notesAction, /update_participant_event_notes/);
  assert.match(ticketPage, /Observações do ingresso/);
  assert.match(ticketPage, /operational_notes/);
  assert.match(inscricoesPage, /Observações cadastrais/);
});

test('transferencia de propriedade continua na RPC existente', async () => {
  const actions = await read('../src/app/ingressos/[ticketId]/editar/actions.ts');
  assert.match(actions, /admin_transfer_ticket_ownership/);
  assert.doesNotMatch(actions, /admin_set_ticket_holder_name[\s\S]{0,80}transferTicketOwnershipAction/);
});
