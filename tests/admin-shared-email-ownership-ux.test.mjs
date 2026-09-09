import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  countSharedEmails,
  currentSharedEmailPrincipalId,
  matchesSharedEmailFilter,
  parseSharedEmailFilter,
  sharedEmailBadgeLabel,
  sharedEmailCountersLabel,
  sharedEmailGroupCount,
  sharedEmailGroupStatus,
  sharedEmailResolvedAccountLabel,
  validateTicketAccountOwnerReason,
} from '../src/lib/account/shared-email-ownership.ts';

const migration = await readFile(new URL('../supabase/migrations/20261013000000_admin_shared_email_ownership_ux.sql', import.meta.url), 'utf8');
const claim = await readFile(new URL('../supabase/migrations/20261009000000_linked_account_ticket_ownership.sql', import.meta.url), 'utf8');
const cadastrosPage = await readFile(new URL('../src/app/cadastros/page.tsx', import.meta.url), 'utf8');
const cadastroList = await readFile(new URL('../src/app/cadastros/cadastro-list.tsx', import.meta.url), 'utf8');
const personPage = await readFile(new URL('../src/app/cadastros/[id]/page.tsx', import.meta.url), 'utf8');
const card = await readFile(new URL('../src/app/cadastros/shared-email-account-card.tsx', import.meta.url), 'utf8');
const managePage = await readFile(new URL('../src/app/cadastros/[id]/conta-compartilhada/page.tsx', import.meta.url), 'utf8');
const manageForm = await readFile(new URL('../src/app/cadastros/shared-email-account-manage-form.tsx', import.meta.url), 'utf8');
const loader = await readFile(new URL('../src/lib/account/load-shared-email-group.ts', import.meta.url), 'utf8');
const ticketPage = await readFile(new URL('../src/app/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
const ticketOwnerUi = await readFile(new URL('../src/app/ingressos/[ticketId]/change-ticket-account-owner.tsx', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/cadastros/shared-email-actions.ts', import.meta.url), 'utf8');
const minhaConta = await readFile(new URL('../src/app/minha-conta/ingressos/page.tsx', import.meta.url), 'utf8');
const portal = await readFile(new URL('../src/lib/account/portal-orders-and-tickets.ts', import.meta.url), 'utf8');
const timeline = await readFile(new URL('../src/lib/admin/ticket-timeline.ts', import.meta.url), 'utf8');

const eighteenGroupEmails = [
  'familia.a@example.com', 'familia.a@example.com',
  'familia.b@example.com', 'familia.b@example.com', 'familia.b@example.com',
  ...Array.from({ length: 16 }, (_, index) => [`grupo${index}@example.com`, `grupo${index}@example.com`]).flat(),
  'unico@example.com',
];

test('T1 — filtro encontra os 18 grupos atuais', () => {
  assert.equal(sharedEmailGroupCount(eighteenGroupEmails), 18);
  assert.equal(parseSharedEmailFilter('pending'), 'pending');
  assert.equal(parseSharedEmailFilter('resolved'), 'resolved');
  assert.equal(parseSharedEmailFilter('all'), 'all');
  assert.equal(parseSharedEmailFilter(''), 'all');
  assert.equal(matchesSharedEmailFilter(1, null, 'all'), true);
  assert.equal(matchesSharedEmailFilter(3, 'resolved', 'all'), true);
  assert.equal(matchesSharedEmailFilter(3, 'pending', 'all'), true);
  assert.match(cadastrosPage, /E-mail compartilhado/);
  assert.match(cadastrosPage, /value="all">Todos/);
  assert.match(cadastrosPage, /Pendentes/);
  assert.match(cadastrosPage, /Resolvidos/);
  assert.match(cadastrosPage, /Pendentes: \{pendingGroups\}/);
  assert.match(cadastrosPage, /Resolvidos: \{resolvedGroups\}/);
  assert.match(cadastrosPage, /sharedEmailCountersLabel\(pendingGroups, resolvedGroups\)/);
  assert.match(cadastrosPage, /shared_email=pending/);
  assert.match(cadastrosPage, /shared_email=resolved/);
});

test('T2 — badge mostra quantidade correta', () => {
  assert.equal(sharedEmailBadgeLabel(2), '2 cadastros neste e-mail');
  assert.equal(sharedEmailBadgeLabel(3), '3 cadastros neste e-mail');
  assert.equal(sharedEmailResolvedAccountLabel('Aline Herbert'), 'Conta: Aline Herbert ✓');
  assert.match(cadastroList, /sharedEmailBadgeLabel\(row\.sharedEmailCount\)/);
  assert.match(cadastroList, /sharedEmailResolvedAccountLabel/);
  assert.match(cadastroList, /conta-compartilhada/);
});

test('T3 — grupo com 3 Pessoas mostra os 3 cadastros', () => {
  assert.match(card, /group\.people\.map/);
  assert.match(card, /Conta compartilhada/);
  assert.match(card, /conta principal/i);
  assert.match(personPage, /SharedEmailAccountCard/);
  assert.match(personPage, /loadSharedEmailGroup/);
  assert.match(managePage, /E-mail compartilhado por \{group\.peopleCount\} cadastros/);
  assert.match(manageForm, /group\.people\.map/);
});

test('T4 — escolher conta principal não altera holder', () => {
  assert.match(migration, /OWNER_HOLDER_MUTATION_FORBIDDEN/);
  assert.doesNotMatch(migration, /set participant_id|set holder_full_name|set registration_contact_id=/);
  assert.match(manageForm, /O titular do ingresso não será alterado/);
  assert.match(ticketOwnerUi, /O titular do ingresso não será alterado/);
  assert.match(card, /Gerenciar conta e ingressos/);
});

test('T5 — conta sem Auth registra intenção, owner continua null', () => {
  assert.match(migration, /set owner_user_id = null/);
  assert.match(migration, /v_materialized boolean := false/);
  assert.match(migration, /intended_owner_contact_id = v_contact\.id/);
  assert.match(manageForm, /Conta ainda não ativada/);
  assert.match(manageForm, /Ownership será concluído após o primeiro acesso/);
  assert.match(card, /Conta ainda não ativada/);
});

test('T6 — claim materializa todos os tickets do grupo', () => {
  assert.match(claim, /materialize_intended_ticket_owners_for_contact\(v_contact\.id, v_actor\)/);
  assert.match(claim, /where t\.intended_owner_contact_id = p_contact_id/);
  assert.match(claim, /and t\.owner_user_id is null/);
});

test('T7 — conta com Auth recebe owner imediatamente', () => {
  assert.match(migration, /v_materialized := true/);
  assert.match(migration, /set owner_user_id = v_auth_user_id/);
  assert.match(migration, /insert into public\.ticket_owner_history/);
  assert.match(manageForm, /propriedade será materializada imediatamente/);
  assert.match(ticketOwnerUi, /propriedade será materializada imediatamente/);
});

test('T8 — alterar owner de um ticket isolado funciona', () => {
  assert.match(migration, /admin_assign_ticket_account_owner/);
  assert.match(ticketPage, /ChangeTicketAccountOwnerCard/);
  assert.match(ticketOwnerUi, /Alterar conta proprietária/);
  assert.doesNotMatch(ticketOwnerUi, /Alterar titular/);
  assert.match(ticketOwnerUi, /Buscar por nome, e-mail ou PIN/);
  assert.match(actions, /assignTicketAccountOwnerAction/);
});

test('T9 — histórico registra alteração', () => {
  assert.match(migration, /insert into public\.ticket_owner_history/);
  assert.match(migration, /ticket_account_owner_assigned/);
  assert.match(migration, /reason_code/);
  assert.match(timeline, /ticket_owner_history/);
  assert.match(ticketOwnerUi, /TICKET_ACCOUNT_OWNER_REASON_OPTIONS/);
  const other = validateTicketAccountOwnerReason('other', 'Correção pontual');
  assert.equal(other.reasonCode, 'other');
  assert.throws(() => validateTicketAccountOwnerReason('other', '  '));
});

test('T10 — Minha Conta passa a refletir novo owner', () => {
  assert.match(portal, /eq\('owner_user_id', userId\)/);
  assert.match(minhaConta, /getAccessibleTicketScope/);
});

test('T11 — comprador permanece inalterado', () => {
  assert.match(migration, /OWNER_BUYER_MUTATION_FORBIDDEN/);
  assert.doesNotMatch(migration, /update public\.orders/);
  assert.match(migration, /buyer_changed', false/);
});

test('T12 — reprocessamento idempotente', () => {
  assert.match(migration, /changed', false/);
  assert.match(migration, /intended_owner_contact_id is not distinct from v_contact\.id/);
  assert.match(migration, /owner_user_id is not distinct from v_auth_user_id/);
  assert.match(loader, /currentSharedEmailPrincipalId/);
  assert.doesNotMatch(loader, /chooseSharedEmailPrincipal/);
});

test('pendência some ao resolver a conta principal; Pessoas não são removidas', () => {
  const alineGroup = [
    { intendedOwnerContactId: null },
    { intendedOwnerContactId: null },
    { intendedOwnerContactId: null },
  ];
  assert.equal(sharedEmailGroupStatus(alineGroup).status, 'pending');
  assert.equal(matchesSharedEmailFilter(3, 'pending', 'pending'), true);
  assert.equal(matchesSharedEmailFilter(3, 'pending', 'resolved'), false);
  const resolved = alineGroup.map(() => ({ intendedOwnerContactId: 'aline' }));
  assert.equal(sharedEmailGroupStatus(resolved).status, 'resolved');
  assert.equal(sharedEmailGroupStatus(resolved).principalId, 'aline');
  assert.equal(matchesSharedEmailFilter(3, 'resolved', 'pending'), false);
  assert.equal(matchesSharedEmailFilter(3, 'resolved', 'resolved'), true);
  assert.equal(sharedEmailCountersLabel(0, 18), 'Pendentes: 0 · Resolvidos: 18');
  const eighteenResolved = Array.from({ length: 18 }, (_, index) => [
    { intendedOwnerContactId: `principal-${index}` },
    { intendedOwnerContactId: `principal-${index}` },
  ]);
  assert.equal(eighteenResolved.filter((tickets) => sharedEmailGroupStatus(tickets).status === 'pending').length, 0);
  assert.equal(eighteenResolved.filter((tickets) => sharedEmailGroupStatus(tickets).status === 'resolved').length, 18);
  assert.equal(sharedEmailBadgeLabel(3), '3 cadastros neste e-mail');
  assert.equal(sharedEmailResolvedAccountLabel('Aline Herbert'), 'Conta: Aline Herbert ✓');
  assert.match(manageForm, /shared_email=resolved/);
  assert.match(cadastrosPage, /as Pessoas permanecem/);
  assert.match(card, /as Pessoas permanecem/);
  assert.doesNotMatch(manageForm, /merge|delete from public\.registration_contacts/i);
});

test('principal atual vem da intenção já gravada, sem recalcular Gate #7', () => {
  const current = currentSharedEmailPrincipalId([
    { intendedOwnerContactId: 'joao' },
    { intendedOwnerContactId: 'joao' },
    { intendedOwnerContactId: 'maria' },
  ]);
  assert.equal(current.id, 'joao');
  assert.equal(current.unanimous, false);
  const empty = currentSharedEmailPrincipalId([{ intendedOwnerContactId: null }]);
  assert.equal(empty.id, null);
  assert.match(loader, /intended_owner_contact_id/);
  assert.doesNotMatch(migration, /20261008000000/);
});
