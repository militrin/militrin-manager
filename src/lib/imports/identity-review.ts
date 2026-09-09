export type ImportIdentityCandidate = {
  registration_contact_id?: string | null;
  reason?: string | null;
  cpf?: string | null;
};

export type ImportIdentityMatchDetails = {
  reason?: string | null;
  candidates?: ImportIdentityCandidate[] | null;
  account_review?: string | null;
  account_review_resolved?: string | null;
} | null | undefined;

const TERMINAL_IMPORT_ROW_STATUSES = new Set([
  'imported',
  'ignored',
  'duplicate',
  'error',
  'cancelled',
  'skipped',
]);

function cpfDigits(value: string | null | undefined) {
  return String(value ?? '').replace(/\D/g, '');
}

function isCpfIdentityReason(reason: string | null | undefined) {
  return reason === 'cpf_exact'
    || reason === 'cpf_and_email_exact'
    || reason === 'strong_identifier_conflict';
}

/**
 * CPF is unique per organization. "Criar novo" cannot create a second Pessoa
 * for the same CPF: import_current_event_contact_first reuses the existing row.
 */
export function importRowHasExistingCpfIdentity(
  details: ImportIdentityMatchDetails,
  importedCpf?: string | null,
): boolean {
  const reason = details?.reason ?? '';
  const candidates = details?.candidates ?? [];
  if (isCpfIdentityReason(reason)) return true;
  if (candidates.some((candidate) => isCpfIdentityReason(candidate.reason))) return true;

  const importedDigits = cpfDigits(importedCpf);
  if (importedDigits.length !== 11) return false;
  return candidates.some((candidate) => cpfDigits(candidate.cpf) === importedDigits);
}

export function isSharedEmailOwnershipReview(
  details: ImportIdentityMatchDetails,
) {
  return details?.account_review === 'shared_email'
    || details?.reason === 'shared_email_account_review';
}

/**
 * Email compartilhado nao e identidade. Depois que a linha materializou
 * pessoas distintas, a fila nao pode continuar pedindo fusao.
 * review_required pendente (CPF Excel, conflito, etc.) continua na fila.
 */
export function isPendingImportIdentityReview(row: {
  status: string;
  resolution: string;
  identity_match_details?: ImportIdentityMatchDetails;
}) {
  const status = String(row.status ?? '');
  if (TERMINAL_IMPORT_ROW_STATUSES.has(status)) return false;
  return status === 'review_required' && String(row.resolution ?? '') === 'pending';
}

export function resolveSharedEmailReviewAfterMaterialization(details: unknown) {
  const current = details && typeof details === 'object' && !Array.isArray(details)
    ? { ...(details as Record<string, unknown>) }
    : {};
  if (current.account_review === 'shared_email' && !current.account_review_resolved) {
    current.account_review_resolved = 'materialized_distinct_identities';
  }
  return current;
}
