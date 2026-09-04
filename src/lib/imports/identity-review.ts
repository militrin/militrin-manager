export type ImportIdentityCandidate = {
  registration_contact_id?: string | null;
  reason?: string | null;
  cpf?: string | null;
};

export type ImportIdentityMatchDetails = {
  reason?: string | null;
  candidates?: ImportIdentityCandidate[] | null;
} | null | undefined;

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
