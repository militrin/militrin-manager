import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ACCOUNT_HEALTH_FILTER_LABEL,
  ACCOUNT_HEALTH_RESOLVE_PERMISSION,
  ACCOUNT_HEALTH_STATE_LABEL,
  accountHealthActionError,
  accountHealthNoAccountCount,
  accountHealthTicketCopy,
  parseAccountHealthFilter,
} from '../src/lib/account/account-health.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  migration,
  actions,
  page,
  casePage,
  caseActions,
  types,
  classify,
  reviewQueue,
  identityReview,
] = await Promise.all([
  read('supabase/migrations/20261104000000_account_health_assisted_resolution.sql'),
  read('src/app/cadastros/saude-contas/actions.ts'),
  read('src/app/cadastros/saude-contas/page.tsx'),
  read('src/app/cadastros/saude-contas/[caseId]/page.tsx'),
  read('src/app/cadastros/saude-contas/health-actions.tsx'),
  read('src/lib/account/account-health.ts'),
  read('src/lib/imports/classify-current-event-purchase.ts'),
  read('src/app/importacoes/revisoes/page.tsx'),
  read('src/lib/imports/identity-review.ts'),
]);

test('A) shared_email oferece keep_without_account', () => {
  assert.match(migration, /when p_state = 'attention' and p_reason_code = 'shared_email' then/);
  assert.match(migration, /array\['keep_without_account', 'provide_own_email', 'open_contact'\]/);
  assert.match(caseActions, /Manter sem conta/);
  assert.match(actions, /keepAccountHealthWithoutAccountAction/);
});

test('B-F) keep nao altera user_id, participant, ticket, owner nem pedido', () => {
  const keep = migration.slice(
    migration.indexOf('create or replace function public.resolve_account_health_keep_without_account'),
    migration.indexOf('create or replace function public.reopen_account_health_resolution'),
  );
  assert.match(keep, /insert into public.account_health_resolutions/);
  assert.doesNotMatch(keep, /update public\.registration_contacts|update public\.participants|update public\.tickets|update public\.orders|owner_user_id|inviteUserByEmail/);
  assert.doesNotMatch(keep, /set user_id/);
});

test('G) reanalise vira reviewed_without_account', () => {
  assert.match(migration, /then 'reviewed_without_account'/);
  assert.equal(ACCOUNT_HEALTH_STATE_LABEL.reviewed_without_account, 'Revisado — sem conta');
  assert.match(page, /Revisados/);
  assert.equal(ACCOUNT_HEALTH_FILTER_LABEL.reviewed_without_account, 'Revisados');
  assert.equal(parseAccountHealthFilter('reviewed_without_account'), 'reviewed_without_account');
  assert.equal(accountHealthNoAccountCount({
    total: 9, healthy: 1, pending_confirmation: 1, no_account: 2, confirmed_unlinked: 1,
    email_divergent: 0, attention: 2, reviewed_without_account: 3, auth_without_contact: 0,
    auth_without_contact_confirmed: 0, possible_orphan: 0, possible_orphan_confirmed: 0,
    possible_orphan_unconfirmed: 0,
  }), 3);
});

test('H) reabrir volta para atencao com auditoria', () => {
  assert.match(migration, /account_health_resolution_reopened/);
  assert.match(migration, /status = 'reopened'/);
  assert.match(caseActions, /Reabrir análise/);
  assert.match(actions, /reopenAccountHealthResolutionAction/);
});

test('I/L) informar e-mail livre atualiza Cadastro e reanalisa para no_account', () => {
  const emailFn = migration.slice(
    migration.indexOf('create or replace function public.correct_account_health_email'),
    migration.indexOf('create or replace function public.resolve_import_shared_email_choice'),
  );
  assert.match(emailFn, /update public\.registration_contacts/);
  assert.match(emailFn, /set email = v_email/);
  assert.match(emailFn, /and user_id is null/);
  assert.match(emailFn, /'next_state', 'no_account'/);
  assert.match(actions, /correctAccountHealthEmailAction/);
  assert.match(caseActions, /Informar e-mail próprio/);
});

test('J/K) e-mail ocupado e cross-org rejeitam sem atualizar', () => {
  assert.match(migration, /Ja existe uma conta com este e-mail/);
  assert.match(migration, /Nao foi possivel usar este e-mail/);
  const emailFn = migration.slice(
    migration.indexOf('create or replace function public.correct_account_health_email'),
    migration.indexOf('create or replace function public.resolve_import_shared_email_choice'),
  );
  assert.match(emailFn, /organization_id is distinct from v_contact.organization_id/);
});

test('M) convite continua separado', () => {
  assert.match(migration, /when p_state = 'no_account' then\s+array\['send_invite', 'open_contact'\]/);
  assert.doesNotMatch(
    migration.slice(
      migration.indexOf('create or replace function public.correct_account_health_email'),
      migration.indexOf('create or replace function public.resolve_import_shared_email_choice'),
    ),
    /invite|participant_account_invites/,
  );
  assert.match(actions, /inviteCadastroFirstAccessAction\(contactId, "contact"\)/);
});

test('N) occupying_email_auth nao recebe acoes de shared_email', () => {
  assert.match(migration, /when p_reason_code = 'occupying_email_auth' then\s+array\['review_identity', 'open_contact'\]/);
  assert.match(caseActions, /Revisar identidade/);
  assert.match(casePage, /Conflito de conta/);
  assert.doesNotMatch(caseActions, /Vincular outra conta|Excluir Auth|Transferir ingresso|Merge/);
});

test('O) mutation exige accounts.health.resolve', () => {
  assert.equal(ACCOUNT_HEALTH_RESOLVE_PERMISSION, 'accounts.health.resolve');
  assert.match(migration, /accounts.health.resolve/);
  assert.match(migration, /role.code = 'administrator'/);
  assert.doesNotMatch(migration, /role.code in \('administrator', 'operational'\)[\s\S]*accounts.health.resolve/);
  assert.match(actions, /assertPermission\(ACCOUNT_HEALTH_RESOLVE_PERMISSION\)/);
  assert.match(actions, /keepAccountHealthWithoutAccountAction/);
});

test('P) import compartilhado e warning nao bloqueante', () => {
  assert.match(classify, /account_review_blocking = false/);
  assert.match(classify, /SHARED_EMAIL_CONTACT_WARNING/);
  assert.match(classify, /status: identityIssues.length \? 'data_pending' : 'ready'/);
  assert.match(reviewQueue, /E-mail compartilhado/);
  assert.match(reviewQueue, /Este endereço também é utilizado por outra pessoa/);
  assert.doesNotMatch(reviewQueue, /keep_shared_contact_email/);
  assert.match(identityReview, /isInheritedSharedEmailReview/);
});

test('Q) ownership fingerprint imutavel nas mutations V2', () => {
  assert.doesNotMatch(migration, /update public\.tickets|update public\.orders/);
  assert.doesNotMatch(migration, /set owner_user_id|set intended_owner_contact_id|set participant_id/);
  assert.doesNotMatch(migration, /update public\.participants[\s\S]{0,180}user_id\s*=/);
});

test('ficha humana, copy de ingressos e permissao de view separada', () => {
  assert.match(casePage, /Como deseja resolver\?/);
  assert.match(casePage, /Por que apareceu aqui/);
  assert.match(casePage, /Nenhum ingresso será transferido|Ingressos não mudam/);
  assert.equal(accountHealthTicketCopy({ is_owner: false, owner_defined: false }), 'A conta deste ingresso ainda não foi definida.');
  assert.doesNotMatch(casePage, /Sem propriedade materializada|auth\.users|owner_user_id/);
  assert.doesNotMatch(page, /auth\.users|owner_user_id|registration_contacts/);
  assert.match(types, /Cadastro.email is the canonical cadastral address/);
  assert.equal(accountHealthActionError({ available_actions: ['open_contact'] }, 'keep_without_account'), 'Esta ação não está disponível para o estado atual.');
});

test('auditoria das resolucoes sem token', () => {
  assert.match(migration, /account_health_keep_without_account/);
  assert.match(migration, /account_health_email_corrected/);
  assert.match(migration, /account_health_resolution_reopened/);
  assert.match(migration, /'old_email', v_old/);
  assert.match(migration, /'new_email', v_email/);
  assert.match(migration, /'decision', 'Nao criar nem vincular conta propria/);
  assert.match(migration, /status = 'reopened'/);
  assert.doesNotMatch(migration, /delete from public\.account_health_resolutions/i);
  assert.doesNotMatch(migration, /select [^;]*confirmation_token/);
  assert.doesNotMatch(actions, /confirmation_token/);
});

test('participant.email acompanha so quando igual ao Cadastro antigo', () => {
  const emailFn = migration.slice(
    migration.indexOf('create or replace function public.correct_account_health_email'),
    migration.indexOf('create or replace function public.resolve_import_shared_email_choice'),
  );
  assert.match(emailFn, /update public\.participants/);
  assert.match(emailFn, /set email = v_email/);
  assert.match(emailFn, /and lower\(trim\(coalesce\(email, ''\)\)\) = v_old/);
  assert.doesNotMatch(emailFn, /user_id\s*=/);
});

test('resolucao keep usa fingerprint e deixa de mascarar contexto novo', () => {
  assert.match(migration, /create or replace function public.account_health_keep_is_current/);
  assert.match(migration, /r.metadata->>'email_norm' = lower\(trim\(coalesce\(p_email, ''\)\)\)/);
  assert.match(migration, /then 'reviewed_without_account'/);
  assert.match(migration, /'email_norm', lower\(trim\(coalesce\(v_contact.email, ''\)\)\)/);
});

test('concorrencia relocka e reclassifica antes da mutation', () => {
  const keep = migration.slice(
    migration.indexOf('create or replace function public.resolve_account_health_keep_without_account'),
    migration.indexOf('create or replace function public.reopen_account_health_resolution'),
  );
  const emailFn = migration.slice(
    migration.indexOf('create or replace function public.correct_account_health_email'),
    migration.indexOf('create or replace function public.resolve_import_shared_email_choice'),
  );
  const reopen = migration.slice(
    migration.indexOf('create or replace function public.reopen_account_health_resolution'),
    migration.indexOf('create or replace function public.correct_account_health_email'),
  );
  assert.match(keep, /for update/);
  assert.match(keep, /v_detail := public.get_account_health_case/);
  assert.match(emailFn, /for update/);
  assert.match(reopen, /for update/);
  assert.match(keep, /unique_violation/);
});

test('email proprio nao dispara convite e CTA fica separado', () => {
  assert.match(actions, /E-mail atualizado. Esta pessoa ainda não possui conta/);
  assert.match(casePage, /E-mail atualizado. Esta pessoa ainda não possui conta/);
  assert.match(caseActions, /Enviar convite/);
  const emailFn = migration.slice(
    migration.indexOf('create or replace function public.correct_account_health_email'),
    migration.indexOf('create or replace function public.resolve_import_shared_email_choice'),
  );
  assert.doesNotMatch(emailFn, /invite|participant_account_invites/);
});

test('occupying nao oferece keep, e-mail proprio, convite nem acesso', () => {
  assert.match(migration, /when p_reason_code = 'occupying_email_auth' then\s+array\['review_identity', 'open_contact'\]/);
  assert.match(actions, /row.reason_code === "occupying_email_auth"/);
});

test('administrator recebe accounts.health.resolve e owner bypass permanece', () => {
  assert.match(migration, /insert into public.admin_roles/);
  assert.match(migration, /where role.code = 'administrator'/);
  assert.match(migration, /on conflict \(code\) do update set/);
  assert.match(migration, /account_health_can_resolve/);
  assert.match(migration, /current_user_has_permission\('accounts.health.resolve'\)/);
});
