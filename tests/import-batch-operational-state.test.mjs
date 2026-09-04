import assert from 'node:assert/strict';
import test from 'node:test';
import {
  importBatchOperationalLabel,
  isCommerciallyCompletedImportStatus,
  isImportRowReadyToImport,
  recentImportBatchPrimaryAction,
  resolveImportBatchOperationalState,
} from '../src/lib/imports/batch-operational-state.ts';

const stagedReadyBatch = {
  status: 'ready_for_review',
  importedRows: 0,
  completedAt: null,
  rows: [{ status: 'ready', resolution: 'create_new' }],
};

const stagedReviewBatch = {
  status: 'ready_for_review',
  importedRows: 0,
  completedAt: null,
  rows: [{ status: 'review_required', resolution: 'pending' }],
};

const completedBatch = {
  status: 'completed',
  importedRows: 1,
  completedAt: '2026-09-04T14:00:00.000Z',
  rows: [{ status: 'imported', resolution: 'create_new' }],
};

test('1) parse com 1 row pronta e 0 reviews libera execucao e nao inventa revisao', () => {
  const state = resolveImportBatchOperationalState(stagedReadyBatch);
  assert.equal(state.phase, 'staged_ready');
  assert.equal(state.unresolvedReviewCount, 0);
  assert.equal(state.importableCount, 1);
  assert.equal(state.canExecute, true);
  assert.equal(state.showIdentityReviewBanner, false);
  assert.equal(state.showAlreadyImportedMessage, false);
  assert.equal(importBatchOperationalLabel(state), 'Arquivo validado — pronto para importar');
  const actions = recentImportBatchPrimaryAction(state, { canManageInvites: true, status: 'ready_for_review' });
  assert.equal(actions.continueImport, true);
  assert.equal(actions.openReviews, false);
  assert.equal(actions.manageInvites, false);
});

test('2) parse com review_required real mostra revisao e bloqueia execucao', () => {
  const state = resolveImportBatchOperationalState(stagedReviewBatch);
  assert.equal(state.phase, 'staged_needs_review');
  assert.equal(state.unresolvedReviewCount, 1);
  assert.equal(state.importableCount, 0);
  assert.equal(state.canExecute, false);
  assert.equal(state.showIdentityReviewBanner, true);
  assert.equal(isImportRowReadyToImport('review_required', 'pending'), false);
  const actions = recentImportBatchPrimaryAction(state, { canManageInvites: true, status: 'ready_for_review' });
  assert.equal(actions.continueImport, false);
  assert.equal(actions.openReviews, true);
  assert.equal(actions.manageInvites, false);
});

test('3) batch stageado reaberto apos refresh continua permitindo execucao', () => {
  const reopened = resolveImportBatchOperationalState({
    ...stagedReadyBatch,
    status: 'ready_for_review',
    importedRows: 0,
    completedAt: null,
  });
  assert.equal(reopened.canExecute, true);
  assert.equal(reopened.showAlreadyImportedMessage, false);
  assert.equal(reopened.showIdentityReviewBanner, false);
  assert.equal(isCommerciallyCompletedImportStatus('ready_for_review'), false);
});

test('4) batch comercialmente concluido nao oferece executar de novo', () => {
  const state = resolveImportBatchOperationalState(completedBatch);
  assert.equal(state.phase, 'commercially_completed');
  assert.equal(state.canExecute, false);
  assert.equal(state.showAlreadyImportedMessage, true);
  assert.equal(state.showIdentityReviewBanner, false);
  const actions = recentImportBatchPrimaryAction(state, { canManageInvites: true, status: 'completed' });
  assert.equal(actions.continueImport, false);
  assert.equal(actions.manageInvites, true);
  const withoutInvitePermission = recentImportBatchPrimaryAction(state, { canManageInvites: false, status: 'completed' });
  assert.equal(withoutInvitePermission.manageInvites, false);
});

test('5) contador global de outro batch nao faz o batch atual parecer ter revisao', () => {
  const current = resolveImportBatchOperationalState(stagedReadyBatch);
  const otherBatchUnresolved = 1;
  assert.equal(current.unresolvedReviewCount, 0);
  assert.equal(current.showIdentityReviewBanner, false);
  assert.notEqual(current.unresolvedReviewCount, otherBatchUnresolved);
});

test('row review resolvida volta a ser importavel; imported nunca reexecuta', () => {
  assert.equal(isImportRowReadyToImport('review_required', 'create_new'), true);
  assert.equal(isImportRowReadyToImport('review_required', 'link_existing'), true);
  assert.equal(isImportRowReadyToImport('imported', 'create_new'), false);
  assert.equal(isImportRowReadyToImport('error', 'pending'), false);
  const mixed = resolveImportBatchOperationalState({
    status: 'ready_for_review',
    importedRows: 1,
    completedAt: null,
    rows: [
      { status: 'imported', resolution: 'create_new' },
      { status: 'review_required', resolution: 'pending' },
    ],
  });
  assert.equal(mixed.canExecute, false);
  assert.equal(mixed.showIdentityReviewBanner, true);
  assert.equal(mixed.showAlreadyImportedMessage, false);
});
