import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [
  importer,
  importPage,
  importActions,
  helper,
] = await Promise.all([
  readFile(new URL('../src/app/importacoes/ImportacoesClient.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/importacoes/page.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/importacoes/actions.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/imports/batch-operational-state.ts', import.meta.url), 'utf8'),
]);

test('wizard deriva execucao das rows, nao de ready_for_review como ja importado', () => {
  assert.match(importer, /resolveImportBatchOperationalState/);
  assert.match(importer, /showExecuteButton/);
  assert.match(importer, /7\) Confirmar importação/);
  assert.match(importer, /Arquivo validado — pronto para importar|importBatchOperationalLabel/);
  assert.doesNotMatch(importer, /isExecutedBatchStatus/);
  assert.doesNotMatch(importer, /\['completed', 'ready_for_review', 'failed', 'cancelled'\]/);
  assert.match(importer, /Este lote já foi importado/);
  assert.doesNotMatch(importer, /Este lote já foi processado \(/);
  assert.match(helper, /'staged_ready'/);
  assert.match(helper, /'staged_needs_review'/);
  assert.match(importActions, /status: 'ready_for_review'/);
  assert.match(importActions, /arquivo validado e/);
});

test('banner de revisao deste lote so aparece pela contagem real das rows', () => {
  assert.match(importer, /showIdentityReviewBanner/);
  assert.match(importer, /Revisões de identidade pendentes deste lote/);
  assert.match(importer, /Abrir revisões deste lote/);
  assert.match(importer, /Revisões neste lote: \{summary\.reviewRows\}/);
  assert.doesNotMatch(importer, /openedBatch\?\.status === 'ready_for_review'/);
  assert.match(importPage, /Revisões pendentes na organização/);
  assert.doesNotMatch(importPage, /Revisões pendentes \(\{/);
  assert.match(importPage, /import_batch_rows\(status,resolution\)/);
});

test('lote stageado reaberto reconstruido por batchId continua no passo 7', () => {
  assert.match(importer, /getImportBatchDetailsAction\(initialBatchId\)/);
  assert.match(importer, /operationalState\.canExecute/);
  assert.match(importer, /O arquivo já foi validado e gravado/);
  assert.match(importPage, /Continuar importação/);
  assert.match(importActions, /operationalState: resolveImportBatchOperationalState/);
});

test('lote concluido mostra pos-importacao e nao reexecuta; convites exigem completed', () => {
  assert.match(importer, /openedBatch\?\.status === 'completed'/);
  assert.match(importer, /showInvitePanel/);
  assert.match(importer, /ImportAccountInvites/);
  assert.match(importPage, /Gerenciar convites/);
  assert.match(helper, /manageInvites: String\(options\.status\) === 'completed'/);
  assert.match(importActions, /isCommerciallyCompletedImportStatus/);
  assert.match(importActions, /Este lote ja foi importado/);
  const execute = importActions.slice(importActions.indexOf('export async function executeImportBatchAction'));
  const completedGuard = execute.indexOf('isCommerciallyCompletedImportStatus');
  const persistIntent = execute.indexOf('payment_mode_original: persistedPaymentMode');
  assert.ok(completedGuard >= 0 && completedGuard < persistIntent, 'lote concluido precisa ser recusado antes de persistir intencao financeira');
});

test('confirm_all continua exigindo finance.confirm_payment; pending permanece o default', () => {
  const execute = importActions.slice(importActions.indexOf('export async function executeImportBatchAction'));
  const permissionGate = execute.indexOf("hasPermission('finance.confirm_payment')");
  const persistIntent = execute.indexOf('payment_mode_original: persistedPaymentMode');
  assert.ok(permissionGate >= 0 && permissionGate < persistIntent);
  assert.match(execute, /if \(paymentMode === 'confirm_all'\)/);
  assert.match(execute, /Sem permissao para confirmar pagamentos e emitir ingressos/);
  assert.match(importer, /useState<'pending' \| 'confirm_all'>\('pending'\)/);
  assert.match(importer, /canConfirmPayment/);
  assert.match(importer, /Manter como pendente/);
});

test('refresh e double submit nao disparam execute duplicado', () => {
  assert.match(importer, /inFlightImportExecutions/);
  assert.match(importer, /executeStarted/);
  assert.match(importer, /inFlightImportExecutions\.has\(batchId\)/);
  assert.match(importActions, /isImportRowReadyToImport/);
  assert.match(helper, /status === 'imported'\) return false/);
});
