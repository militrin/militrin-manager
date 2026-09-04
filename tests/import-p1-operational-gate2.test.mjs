import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { importRowHasExistingCpfIdentity } from '../src/lib/imports/identity-review.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  importer,
  importPage,
  invitesPanel,
  cadastroActions,
  reviewQueue,
  identityHelper,
  issuesDialog,
  cadastrosPage,
  middleware,
  firstAccessPage,
  inviteButton,
  participantInvite,
  importActions,
  resendAction,
  dispatchLib,
  inviteJobsMigration,
] = await Promise.all([
  read('src/app/importacoes/ImportacoesClient.tsx'),
  read('src/app/importacoes/page.tsx'),
  read('src/app/importacoes/import-account-invites.tsx'),
  read('src/app/cadastros/actions.ts'),
  read('src/app/importacoes/revisoes/page.tsx'),
  read('src/lib/imports/identity-review.ts'),
  read('src/app/inscricoes/participant-issues-dialog.tsx'),
  read('src/app/cadastros/page.tsx'),
  read('middleware.ts'),
  read('src/app/primeiro-acesso/page.tsx'),
  read('src/app/cadastros/invite-account-button.tsx'),
  read('src/lib/account/participant-invite.ts'),
  read('src/app/importacoes/actions.ts'),
  read('src/app/primeiro-acesso/reenviar/actions.ts'),
  read('src/lib/account/first-access-invite-dispatch.ts'),
  read('supabase/migrations/20260887000000_import_account_invite_jobs.sql'),
]);

function protectedPrefixesFrom(source) {
  const block = source.slice(source.indexOf('const protectedPrefixes'), source.indexOf('const isPublicFirstAccessResend'));
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function middlewareRequiresAuth(pathname) {
  const prefixes = protectedPrefixesFrom(middleware);
  const isPublicFirstAccessResend = pathname === '/primeiro-acesso/reenviar';
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) && !isPublicFirstAccessResend;
}

test('P1-1 lote persistido e convites reencontraveis sem report em memoria', () => {
  assert.match(importPage, /Lotes recentes/);
  assert.match(importPage, /Gerenciar convites/);
  assert.match(importPage, /\/importacoes\?batchId=/);
  assert.match(importer, /showInvitePanel/);
  assert.match(importer, /openedBatch\?\.status === 'completed'/);
  assert.doesNotMatch(importer, /\{report && batchId \? <ImportAccountInvites/);
  assert.match(invitesPanel, /getImportAccountInviteOperationalStatusAction/);
  assert.match(cadastroActions, /assertPermission\("participants\.edit_basic"\)/);
  assert.match(cadastroActions, /withoutInvite/);
  assert.match(cadastroActions, /pendingInvite/);
  assert.match(cadastroActions, /claimed/);
});

test('P1-2 nao inventa token paralelo nem copia link Auth', () => {
  assert.doesNotMatch(inviteButton, /generateLink|navigator\.clipboard/i);
  assert.match(inviteButton, /não copia nem exibe token/);
  assert.match(inviteButton, /Reenviar convite/);
  assert.match(inviteButton, /Validade/);
  assert.match(middleware, /pathname === '\/primeiro-acesso\/reenviar'/);
  assert.match(firstAccessPage, /failureCopy\.actionHref/);
  assert.match(participantInvite, /actionHref: '\/primeiro-acesso\/reenviar'/);
  assert.doesNotMatch(
    cadastroActions.slice(
      cadastroActions.indexOf('export async function getImportAccountInviteOperationalStatusAction'),
      cadastroActions.indexOf('export async function processImportAccountInviteJobChunkAction'),
    ),
    /invite_token|access_token|token_hash|generateLink/,
  );
});

test('P1-3 wizard explicita pending vs confirm_all sem mudar o default', () => {
  assert.match(importer, /useState<'pending' \| 'confirm_all'>\('pending'\)/);
  assert.match(importer, /Manter como pendente/);
  assert.match(importer, /Importar como pendente, sem emitir ingresso/);
  assert.match(importer, /Confirmar todos como pagos e emitir ingressos/);
  assert.match(importer, /Equivale a/);
  assert.match(importer, /confirm_all/);
  assert.match(importer, /não emitirá ingresso/);
  assert.match(importer, /finance\.confirm_payment/);
});

test('P1-4 CPF existente nao promete criar nova Pessoa', () => {
  assert.match(identityHelper, /importRowHasExistingCpfIdentity/);
  assert.match(importer, /importRowHasExistingCpfIdentity/);
  assert.match(reviewQueue, /importRowHasExistingCpfIdentity/);
  assert.match(reviewQueue, /Não é possível criar outra Pessoa com o mesmo CPF/);
  assert.match(reviewQueue, /hasExistingCpf \? null : \(\s*<form action=\{submitReview\}/);
  assert.equal(importRowHasExistingCpfIdentity({ reason: 'cpf_exact', candidates: [{ reason: 'cpf_exact', cpf: '52998224725' }] }, '52998224725'), true);
  assert.equal(importRowHasExistingCpfIdentity({ reason: 'name_only_suggestion', candidates: [{ reason: 'name_only_suggestion', cpf: '11144477735' }] }, '52998224725'), false);
  assert.equal(importRowHasExistingCpfIdentity({ reason: 'email_exact_requires_review', candidates: [{ reason: 'email_exact', cpf: '52998224725' }] }, '529.982.247-25'), true);
});

test('P1-5 nao promete filtro pending=yes; aponta para fluxo canonico', () => {
  assert.doesNotMatch(importer, /pending=yes/);
  assert.doesNotMatch(issuesDialog, /pending=yes/);
  assert.doesNotMatch(cadastrosPage, /pending=yes/);
  assert.match(importer, /\/cadastros\?import_batch_id=/);
  assert.match(importer, /Ver pessoas deste lote/);
  assert.match(importer, /\/importacoes\/revisoes\?batchId=/);
  assert.match(issuesDialog, /Ver demais pessoas deste lote/);
  assert.match(cadastrosPage, /params\.import_batch_id/);
  assert.match(invitesPanel, /Abrir pessoas deste lote/);
});

test('1) /primeiro-acesso/reenviar e publico por igualdade exata, nao por prefixo', () => {
  assert.equal(middlewareRequiresAuth('/primeiro-acesso/reenviar'), false);
  assert.match(middleware, /const isPublicFirstAccessResend = pathname === '\/primeiro-acesso\/reenviar'/);
  assert.doesNotMatch(middleware, /isPublicFirstAccessResend = pathname\.startsWith/);
});

test('2) demais rotas de primeiro acesso continuam protegidas e callback nao entra na lista', () => {
  assert.equal(middlewareRequiresAuth('/primeiro-acesso'), true);
  assert.equal(middlewareRequiresAuth('/primeiro-acesso/pendencias'), true);
  assert.equal(middlewareRequiresAuth('/primeiro-acesso/reenviar/extra'), true);
  assert.equal(middlewareRequiresAuth('/auth/callback'), false);
  assert.equal(middlewareRequiresAuth('/auth/confirm'), false);
  const protectedList = middleware.slice(middleware.indexOf('const protectedPrefixes'), middleware.indexOf('const isPublicFirstAccessResend'));
  assert.match(protectedList, /'\/primeiro-acesso'/);
  assert.doesNotMatch(protectedList, /'\/auth\/callback'/);
});

test('reenvio publico anti-enumeracao, sem conta nova, sem token e sem wildcard de e-mail', () => {
  assert.match(resendAction, /GENERIC_MESSAGE/);
  assert.match(resendAction, /\.eq\("email", email\)/);
  assert.doesNotMatch(resendAction, /\.ilike\("email"/);
  assert.match(resendAction, /\.eq\("status", "pending"\)/);
  assert.match(resendAction, /\.is\("password_setup_completed_at", null\)/);
  assert.match(dispatchLib, /shouldCreateUser: false/);
  assert.doesNotMatch(resendAction, /\.inviteUserByEmail\(/);
  assert.doesNotMatch(resendAction, /token_hash|access_token|generateLink/);
  assert.match(resendAction, /rate limit/);
});

test('3) lote reaberto reidrata por batchId persistido, sem report em memoria', () => {
  assert.match(importer, /getImportBatchDetailsAction\(initialBatchId\)/);
  assert.match(importer, /applyBatchDetails/);
  assert.match(importer, /Lote reaberto/);
  assert.match(importer, /openedBatch\?\.status === 'completed'/);
  assert.match(importPage, /initialBatchId=\{batchId\}/);
  assert.match(importActions, /export async function getImportBatchDetailsAction/);
});

test('4) batch de outra org e bloqueado na action e no job SQL', () => {
  assert.match(importActions, /Sem acesso a organizacao deste lote/);
  assert.match(importActions, /user_can_access_organization/);
  assert.match(cadastroActions, /createServerSupabaseClient\(\)/);
  assert.match(inviteJobsMigration, /user_can_access_organization\(v_actor,v_batch\.organization_id\)/);
  assert.match(inviteJobsMigration, /ib\.status='completed'/);
  const statusAction = cadastroActions.slice(
    cadastroActions.indexOf('export async function getImportAccountInviteOperationalStatusAction'),
    cadastroActions.indexOf('export async function processImportAccountInviteJobChunkAction'),
  );
  assert.doesNotMatch(statusAction, /createServiceRoleSupabaseClient/);
  assert.match(statusAction, /from\("import_batches"\)/);
});

test('5-7) confirm_all exige finance.confirm_payment no backend antes de persistir intencao; pending nao emite', () => {
  const execute = importActions.slice(importActions.indexOf('export async function executeImportBatchAction'));
  const permissionGate = execute.indexOf("hasPermission('finance.confirm_payment')");
  const persistIntent = execute.indexOf('payment_mode_original: persistedPaymentMode');
  const finalizeCall = execute.indexOf("finalize_imported_ticket_after_issue_resolution");
  assert.ok(permissionGate >= 0, 'gate financeiro precisa existir na action');
  assert.ok(permissionGate < persistIntent, 'permissao precisa ser checada antes de gravar confirm_all');
  assert.match(execute, /if \(paymentMode === 'confirm_all'\)/);
  assert.match(execute, /Sem permissao para confirmar pagamentos e emitir ingressos/);
  assert.match(execute, /if \(!hasBlockingDataIssues && persistedPaymentMode === 'confirm_all'\)/);
  assert.ok(finalizeCall > persistIntent);
  assert.match(importer, /useState<'pending' \| 'confirm_all'>\('pending'\)/);
});

test('8) CPF existente nao oferece create_new; backend continua autoridade de unicidade', () => {
  assert.equal(importRowHasExistingCpfIdentity({ reason: 'cpf_exact' }, '52998224725'), true);
  assert.equal(importRowHasExistingCpfIdentity({ reason: 'name_only_suggestion', candidates: [{ reason: 'name_only_suggestion' }] }, '52998224725'), false);
  assert.match(reviewQueue, /hasExistingCpf \? null : \(\s*<form action=\{submitReview\}/);
  assert.match(importer, /hasExistingCpf \? null : <option value="create_new">/);
  assert.match(identityHelper, /nao duplica Pessoa|Não é possível criar outra Pessoa|reuses the existing row/i);
  assert.match(importActions, /import_current_event_contact_first/);
  assert.match(importActions, /decision: z\.enum\(\[/);
  assert.match(importActions, /'link_existing'/);
  assert.match(importActions, /'create_new'/);
  assert.match(importActions, /'ignore'/);
  assert.match(importActions, /'assign_owner_contact'/);
});

test('9) filtro import_batch_id e da org atual e nao cria terceira fila', () => {
  assert.match(cadastrosPage, /\.eq\("organization_id", organization\.id\)/);
  assert.match(cadastrosPage, /params\.import_batch_id && !row\.importBatchIds\.includes\(params\.import_batch_id\)/);
  assert.doesNotMatch(cadastrosPage, /pending=yes/);
  assert.match(importer, /\/importacoes\/revisoes\?batchId=/);
  assert.match(importer, /Ver pessoas deste lote/);
});

test('ready_for_review nao inicia job; completed e exigido no SQL', () => {
  assert.match(inviteJobsMigration, /ib\.status='completed'/);
  assert.match(inviteJobsMigration, /status='completed' for update/);
  assert.match(importer, /showIdentityReviewBanner/);
  assert.match(importer, /Ainda não pode enviar convites|ainda não pode enviar convites/);
  assert.match(importer, /openedBatch\?\.status === 'completed'/);
  assert.doesNotMatch(importer, /isExecutedBatchStatus/);
  assert.match(importPage, /canManageInvites/);
  assert.match(importPage, /Continuar importação/);
  assert.match(importPage, /Gerenciar convites/);
  assert.match(importPage, /Revisões pendentes na organização/);
});
