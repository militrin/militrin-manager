import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ACCOUNT_HEALTH_FILTER_LABEL,
  ACCOUNT_HEALTH_PERMISSION,
  ACCOUNT_HEALTH_STATE_LABEL,
  accountHealthActionError,
  accountHealthFiltersForActor,
  accountHealthHref,
  accountHealthNoAccountCount,
  parseAccountHealthFilter,
} from '../src/lib/account/account-health.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  migration,
  actions,
  page,
  casePage,
  list,
  filters,
  caseActions,
  layout,
  menu,
  cadastrosPage,
  panelAccess,
  types,
] = await Promise.all([
  read('supabase/migrations/20261102000000_account_health_center.sql'),
  read('src/app/cadastros/saude-contas/actions.ts'),
  read('src/app/cadastros/saude-contas/page.tsx'),
  read('src/app/cadastros/saude-contas/[caseId]/page.tsx'),
  read('src/app/cadastros/saude-contas/health-list.tsx'),
  read('src/app/cadastros/saude-contas/health-filters.tsx'),
  read('src/app/cadastros/saude-contas/health-actions.tsx'),
  read('src/app/cadastros/saude-contas/layout.tsx'),
  read('src/lib/navigation/admin-menu.ts'),
  read('src/app/cadastros/page.tsx'),
  read('src/lib/admin/panel-access.ts'),
  read('src/lib/account/account-health.ts'),
]);

test('A) estados e filtros humanos cobrem saudavel ate atencao', () => {
  for (const state of ['healthy', 'pending_confirmation', 'no_account', 'attention']) {
    assert.ok(ACCOUNT_HEALTH_STATE_LABEL[state]);
  }
  assert.equal(parseAccountHealthFilter('pending_confirmation'), 'pending_confirmation');
  assert.equal(parseAccountHealthFilter('nope'), 'all');
  assert.equal(accountHealthNoAccountCount({
    total: 10, healthy: 1, pending_confirmation: 1, no_account: 2, confirmed_unlinked: 3,
    email_divergent: 0, attention: 0, reviewed_without_account: 4, auth_without_contact: 0, auth_without_contact_confirmed: 0,
    possible_orphan: 0, possible_orphan_confirmed: 0, possible_orphan_unconfirmed: 0,
  }), 5);
});

test('B) Cadastro sem conta e convite canonico', () => {
  assert.match(migration, /array\['send_invite', 'open_contact'\]/);
  assert.match(actions, /sendAccountHealthInviteAction/);
  assert.match(actions, /inviteCadastroFirstAccessAction\(contactId, "contact"\)/);
  assert.match(caseActions, /Enviar convite/);
});

test('C) Auth pendente + Cadastro oferece reenvio GoTrue', () => {
  assert.match(migration, /pending_email_confirmation/);
  assert.match(actions, /resendSignupConfirmation/);
  assert.match(actions, /get_registration_contact_account_state/);
  assert.match(caseActions, /Reenviar confirmação/);
  assert.doesNotMatch(actions, /inviteUserByEmail/);
});

test('D) conta confirmada segura usa Enviar acesso', () => {
  assert.match(migration, /confirmed_unlinked/);
  assert.match(migration, /send_access/);
  assert.match(caseActions, /Enviar acesso/);
});

test('E/F) e-mail e participacao divergentes nao autorizam merge', () => {
  assert.match(migration, /email_divergent/);
  assert.match(migration, /participant_email_mismatch/);
  assert.match(migration, /email_mismatch/);
  assert.doesNotMatch(migration, /delete_orphan_auth_user|update public\.tickets|owner_cancel_ticket/);
  assert.doesNotMatch(caseActions, /Excluir|Merge|Consolidar|Resolver automaticamente/);
});

test('G) Auth pendente conflitante vira atencao sem correcao automatica', () => {
  assert.match(migration, /occupying_email_auth/);
  assert.match(casePage, /Conflito de conta/);
  assert.match(caseActions, /Revisar identidade/);
  assert.match(caseActions, /tratamento excepcional/);
});

test('H) possivel orfa sem botao destrutivo', () => {
  assert.match(migration, /possible_orphan/);
  assert.match(caseActions, /Possível conta sem vínculo operacional/);
  assert.doesNotMatch(caseActions, /Excluir/);
  assert.match(migration, /v_include_orphans := public.is_active_owner\(v_actor\)/);
});

test('I) escopo por organizacao, sem enumeracao global', () => {
  assert.match(migration, /user_can_access_organization\(v_actor, o.id\)/);
  assert.match(migration, /Nao enumera auth.users global/);
  assert.match(migration, /and not exists \(\s+select 1 from public.registration_contacts c\s+where c.organization_id = v_org/);
  assert.match(actions, /p_organization_id: organization.id/);
});

test('J/K) acoes revalidam estado no servidor e reanalisam', () => {
  const reanalyze = actions.slice(
    actions.indexOf('export async function reanalyzeAccountHealthCaseAction'),
    actions.indexOf('export async function resendAccountHealthConfirmationAction'),
  );
  assert.match(actions, /async function loadCase[\s\S]*get_account_health_case/);
  assert.match(reanalyze, /loadCase\(caseId\)/);
  assert.match(reanalyze, /Situação atualizada/);
  assert.doesNotMatch(reanalyze, /inviteCadastroFirstAccessAction|resendSignupConfirmation|from\("registration_contacts"\)|from\("tickets"\)/);
  assert.match(actions, /accountHealthActionError\(row, "resend_confirmation"\)/);
  assert.match(actions, /accountHealthActionError\(row, expectedAction\)/);
  assert.match(caseActions, /Reanalisar/);
  assert.equal(accountHealthActionError({ available_actions: ['open_contact'] }, 'resend_confirmation'), 'Esta ação não está disponível para o estado atual.');
  assert.equal(accountHealthActionError({ available_actions: ['resend_confirmation'] }, 'resend_confirmation'), null);
});

test('L/M) ownership e titular nao mudam nesta V1', () => {
  assert.doesNotMatch(migration, /update public\.tickets|update public\.orders/);
  assert.doesNotMatch(actions, /owner_cancel_ticket|prepare_ticket_transfer/);
  assert.doesNotMatch(casePage, /confirmation_token/);
});

test('N) Laiz nao e regra especial; consolidado e saudavel generico', () => {
  assert.doesNotMatch(migration, /laizlagofelicidade|Laiz|eb758cdb/i);
  assert.doesNotMatch(page + casePage + types, /laizlagofelicidade|Laiz/i);
  assert.match(migration, /Cadastro, conta confirmada e vinculo coerentes/);
});

test('descoberta: Cadastros → Saúde de contas no menu e na lista', () => {
  assert.match(menu, /label: "Saúde de contas"/);
  assert.match(menu, /href: "\/cadastros\/saude-contas"/);
  assert.match(menu, /accounts.health.view/);
  assert.match(cadastrosPage, /href="\/cadastros\/saude-contas"/);
  assert.match(cadastrosPage, /Saúde de contas/);
  assert.match(layout, /ACCOUNT_HEALTH_PERMISSION/);
  assert.equal(ACCOUNT_HEALTH_PERMISSION, 'accounts.health.view');
  assert.match(panelAccess, /accounts.health.view/);
});

test('UI mobile-first, linguagem humana e paginacao server-side', () => {
  assert.match(page, /AdminStatCard/);
  assert.match(page, /Aguardando confirmação/);
  assert.match(list, /lg:hidden/);
  assert.match(list, /Abrir caso/);
  assert.match(filters, /Nome, CPF ou e-mail/);
  assert.doesNotMatch(page, /auth\.users|registration_contacts|owner_user_id/);
  assert.doesNotMatch(list, /auth\.users|registration_contacts|owner_user_id/);
  assert.match(casePage, /código do ingresso não é exibido/);
  assert.match(migration, /p_limit integer default 25/);
  assert.match(migration, /offset v_offset/);
  assert.ok(ACCOUNT_HEALTH_FILTER_LABEL.possible_orphan);
  assert.match(accountHealthHref({ state: 'attention' }), /estado=attention/);
});

test('auditoria das acoes sem token', () => {
  assert.match(actions, /account_health_confirmation_resent/);
  assert.match(actions, /account_health_invite_sent/);
  assert.match(actions, /account_health_access_sent/);
  assert.doesNotMatch(actions, /confirmation_token/);
  assert.doesNotMatch(migration, /select [^;]*confirmation_token/);
});

test('permissao nao e de kit/check-in', () => {
  assert.match(migration, /role.code = 'administrator'/);
  assert.match(migration, /insert into public.admin_roles[\s\S]*'administrator'/);
  assert.match(migration, /on conflict \(code\) do update set[\s\S]*is_system = true/);
  assert.match(migration, /on conflict \(role_id, permission_id\) do nothing/);
  assert.doesNotMatch(migration, /role.code in \('administrator', 'operational'\)[\s\S]*accounts.health.view/);
  assert.match(layout, /requirePermission\(ACCOUNT_HEALTH_PERMISSION\)/);
});

test('Possivel orfa so aparece para platform owner', () => {
  assert.equal(parseAccountHealthFilter('possible_orphan', false), 'all');
  assert.equal(parseAccountHealthFilter('possible_orphan', true), 'possible_orphan');
  assert.equal(accountHealthFiltersForActor(false).includes('possible_orphan'), false);
  assert.equal(accountHealthFiltersForActor(true).includes('possible_orphan'), true);
  assert.match(page, /canViewOrphans \? \(/);
  assert.match(page, /canViewOrphans=\{canViewOrphans\}/);
  assert.match(filters, /accountHealthFiltersForActor\(canViewOrphans\)/);
});

test('um estado primario por Cadastro; flags coexistentes; case_id estavel', () => {
  const classified = migration.slice(migration.indexOf('classified_contacts as ('), migration.indexOf('org_auth as ('));
  assert.match(classified, /end as state/);
  assert.equal((classified.match(/end as state/g) || []).length, 1);
  assert.match(classified, /c\.id::text as case_id/);
  assert.match(migration, /when c\.user_id is not null then 'healthy'/);
  assert.match(migration, /cf\.shared_email/);
  assert.match(migration, /cf\.participant_email_divergent/);
  assert.doesNotMatch(classified, /when c\.user_id is not null and cf\.participant_email_divergent then 'email_divergent'/);
  assert.match(migration, /\('auth-' \|\| u\.id::text\) as case_id/);
  assert.match(migration, /\('orphan-' \|\| u\.id::text\) as case_id/);
  assert.match(migration, /union all/);
  assert.match(types, /shared_email: boolean/);
});
