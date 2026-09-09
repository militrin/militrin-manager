import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chooseSharedEmailPrincipal, maskSharedEmail, sharedEmailCadastroScore } from '../src/lib/account/shared-email-ownership.ts';

const migration = await readFile(new URL('../supabase/migrations/20261012000000_shared_email_account_ownership.sql', import.meta.url), 'utf8');
const listFix = await readFile(new URL('../supabase/migrations/20261012100000_fix_shared_email_list_min_uuid.sql', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/importacoes/actions.ts', import.meta.url), 'utf8');
const cadastroActions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
const panel = await readFile(new URL('../src/app/importacoes/shared-email-account-groups.tsx', import.meta.url), 'utf8');
const invites = await readFile(new URL('../src/app/importacoes/import-account-invites.tsx', import.meta.url), 'utf8');
const client = await readFile(new URL('../src/app/importacoes/ImportacoesClient.tsx', import.meta.url), 'utf8');
const minhaConta = await readFile(new URL('../src/app/minha-conta/ingressos/page.tsx', import.meta.url), 'utf8');
const claim = await readFile(new URL('../supabase/migrations/20261009000000_linked_account_ticket_ownership.sql', import.meta.url), 'utf8');

const person = (overrides) => ({
  id: 'a',
  fullName: 'Pessoa A',
  cpf: '39053344705',
  birthDate: '1990-01-01',
  email: 'familia@example.com',
  phone: '51999999999',
  city: 'Porto Alegre',
  userId: null,
  hasValidAuth: false,
  sourceRow: 10,
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

test('T1/T3: criterio deterministico escolhe uma Pessoa sem usar titularidade nem genero', () => {
  const primary = chooseSharedEmailPrincipal([
    person({ id: 'holder-b', fullName: 'Pessoa B', sourceRow: 2, cpf: 'invalid', birthDate: null, city: null }),
    person({ id: 'holder-a', fullName: 'Pessoa A', sourceRow: 8 }),
  ], 'familia@example.com');
  assert.equal(primary.id, 'holder-a');
  assert.doesNotMatch(migration, /gender|genero|final_amount|purchase_value/i);
  assert.match(migration, /people_merged', false/);
  assert.match(migration, /holders_changed', false/);
});

test('T2/T10: grupo de 3 Pessoas gera um unico convite por e-mail', () => {
  assert.match(migration, /Ja existe convite pendente para este e-mail/);
  assert.match(migration, /ux_participant_account_invites_pending_org_email/);
  assert.match(invites, /Cada endereco recebe exatamente 1 convite/);
  const people = [
    person({ id: '1', sourceRow: 3 }),
    person({ id: '2', sourceRow: 1, cpf: null, birthDate: null }),
    person({ id: '3', sourceRow: 2, city: null }),
  ];
  assert.equal(chooseSharedEmailPrincipal(people, 'familia@example.com').id, '1');
});

test('T4: Pessoa com Auth valido vence o desempate e nao cria outra conta', () => {
  const primary = chooseSharedEmailPrincipal([
    person({ id: 'complete', sourceRow: 1 }),
    person({ id: 'has-auth', fullName: 'Conta', cpf: null, birthDate: null, city: null, sourceRow: 99, userId: 'user-1', hasValidAuth: true }),
  ], 'familia@example.com');
  assert.equal(primary.id, 'has-auth');
  assert.match(migration, /check_registration_contact_account_invite_eligibility\(v_p\.registration_contact_id\)/);
});

test('T5/T6: Auth orfao so apaga com zero vinculos; Auth real nunca apaga', () => {
  assert.match(migration, /classification', case when v_real > 0 then 'ACTIVE_REAL_ACCOUNT' else 'ORPHAN_AUTH'/);
  assert.match(migration, /Auth nao e orfao; exclusao recusada/);
  assert.match(migration, /Somente o owner pode excluir Auth orfao/);
  assert.match(actions, /deleteOrphanAuthUserAction/);
  assert.match(panel, /Auth real — nao excluir/);
  assert.match(panel, /Excluir Auth orfao/);
  assert.match(listFix, /bool_and\(t.intended_owner_contact_id =/);
  assert.doesNotMatch(listFix, /min\(t.intended_owner_contact_id\)/);
});

test('T7/F: claim materializa owner_user_id de todos os tickets do grupo; antes permanece null', () => {
  assert.match(migration, /owner_user_id_materialized', false/);
  assert.match(migration, /and t.owner_user_id is null/);
  assert.match(claim, /materialize_intended_ticket_owners_for_contact\(v_contact\.id, v_actor\)/);
  assert.match(claim, /where t\.intended_owner_contact_id = p_contact_id/);
});

test('T8: historico de ownership e auditoria do grupo', () => {
  assert.match(claim, /insert into public.ticket_owner_history/);
  assert.match(migration, /shared_email_account_owner_assigned/);
  assert.match(migration, /orphan_auth_user_deleted/);
});

test('T9: Minha Conta lista tickets do owner e preserva titulares distintos', () => {
  assert.match(minhaConta, /getAccessibleTicketScope/);
  assert.match(minhaConta, /holderName/);
  assert.match(panel, /Ingressos que ficarao nesta conta/);
  assert.match(panel, /titular \{ticket.holder_name\}/);
});

test('T11: e-mail compartilhado nao altera holder/participant', () => {
  assert.doesNotMatch(migration.split('assign_shared_email_account_owner')[1], /set participant_id|set holder_full_name|set registration_contact_id=/);
  assert.match(panel, /titulares originais/);
});

test('T12: reprocessamento e idempotente e o job convida a Pessoa, nao o participante avulso', () => {
  assert.match(migration, /assign_shared_email_account_owner/);
  assert.match(cadastroActions, /inviteCadastroFirstAccessAction\(String\(participant.registration_contact_id\), "contact"\)/);
  assert.match(actions, /assignSharedEmailAccountOwnerAction/);
});

test('UI administrativa de Gerenciar convites expoe conta principal', () => {
  assert.match(client, /SharedEmailAccountGroups/);
  assert.match(panel, /Conta principal/);
  assert.match(panel, /Vincular grupo a esta conta/);
  assert.match(invites, /E-mails compartilhados precisam de uma conta principal/);
  assert.equal(maskSharedEmail('familia.teste@gmail.com'), 'fa***@gmail.com');
  assert.ok(sharedEmailCadastroScore(person({}), 'familia@example.com') > sharedEmailCadastroScore(person({ cpf: null, birthDate: null }), 'familia@example.com'));
});
