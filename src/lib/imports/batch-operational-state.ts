export type ImportBatchRowRef = {
  status: string;
  resolution: string;
};

export type ImportBatchOperationalPhase =
  | 'staged_ready'
  | 'staged_needs_review'
  | 'commercially_completed';

export type ImportBatchOperationalState = {
  phase: ImportBatchOperationalPhase;
  unresolvedReviewCount: number;
  importableCount: number;
  importedRows: number;
  commerciallyCompleted: boolean;
  canExecute: boolean;
  showIdentityReviewBanner: boolean;
  showAlreadyImportedMessage: boolean;
  isStaged: boolean;
};

export function isImportRowReadyToImport(status: string, resolution: string) {
  if (status === 'error') return false;
  // Ja materializada -- reprocessar o lote nunca deve tentar de novo.
  if (status === 'imported') return false;
  if (status === 'duplicate') return resolution === 'create_new';
  if (status === 'review_required') return resolution === 'link_existing' || resolution === 'create_new';
  return true;
}

export function countUnresolvedImportReviews(rows: ImportBatchRowRef[]) {
  return rows.filter((row) => row.status === 'review_required' && row.resolution === 'pending').length;
}

export function isCommerciallyCompletedImportStatus(status: string | null | undefined) {
  return ['completed', 'failed', 'cancelled'].includes(String(status ?? ''));
}

export function resolveImportBatchOperationalState(input: {
  status?: string | null;
  importedRows?: number | null;
  completedAt?: string | null;
  rows: ImportBatchRowRef[];
}): ImportBatchOperationalState {
  const status = String(input.status ?? '');
  const importedRows = Number(input.importedRows ?? 0);
  const unresolvedReviewCount = countUnresolvedImportReviews(input.rows);
  const importableCount = input.rows.filter((row) => isImportRowReadyToImport(row.status, row.resolution)).length;
  const commerciallyCompleted = isCommerciallyCompletedImportStatus(status);
  const canExecute = !commerciallyCompleted && importableCount > 0;
  const showIdentityReviewBanner = unresolvedReviewCount > 0 && !commerciallyCompleted;
  const showAlreadyImportedMessage = commerciallyCompleted;
  const isStaged = !commerciallyCompleted;
  const phase: ImportBatchOperationalPhase = commerciallyCompleted
    ? 'commercially_completed'
    : unresolvedReviewCount > 0
      ? 'staged_needs_review'
      : 'staged_ready';

  return {
    phase,
    unresolvedReviewCount,
    importableCount,
    importedRows,
    commerciallyCompleted,
    canExecute,
    showIdentityReviewBanner,
    showAlreadyImportedMessage,
    isStaged,
  };
}

export function recentImportBatchPrimaryAction(
  state: ImportBatchOperationalState,
  options: { canManageInvites: boolean; status?: string | null },
) {
  return {
    continueImport: state.canExecute,
    openReviews: state.showIdentityReviewBanner,
    manageInvites: String(options.status) === 'completed' && options.canManageInvites,
  };
}

export function importBatchOperationalLabel(state: ImportBatchOperationalState) {
  if (state.phase === 'commercially_completed') return 'Importação concluída';
  if (state.phase === 'staged_needs_review') {
    return `Arquivo validado — ${state.unresolvedReviewCount} revisão(ões) neste lote`;
  }
  return 'Arquivo validado — pronto para importar';
}
