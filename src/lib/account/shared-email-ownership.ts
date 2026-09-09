import { isValidCpf } from '../imports/import-row-validation.ts';

export type SharedEmailPersonCandidate = {
  id: string;
  fullName: string;
  cpf?: string | null;
  birthDate?: string | null;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
  userId?: string | null;
  hasValidAuth?: boolean;
  sourceRow?: number | null;
  createdAt?: string | null;
};

export function sharedEmailCadastroScore(person: SharedEmailPersonCandidate, groupEmail: string) {
  let score = 0;
  if (String(person.fullName ?? '').trim().length >= 3) score += 1;
  if (isValidCpf(person.cpf)) score += 2;
  if (String(person.birthDate ?? '').trim()) score += 2;
  if (String(person.email ?? '').trim().toLowerCase() === String(groupEmail ?? '').trim().toLowerCase()) score += 1;
  if (String(person.phone ?? '').replace(/\D/g, '').length >= 10) score += 1;
  if (String(person.city ?? '').trim()) score += 1;
  return score;
}

export function chooseSharedEmailPrincipal(
  people: SharedEmailPersonCandidate[],
  groupEmail: string,
): SharedEmailPersonCandidate | null {
  if (!people.length) return null;
  return [...people].sort((left, right) => {
    const leftAuth = Boolean(left.hasValidAuth && left.userId);
    const rightAuth = Boolean(right.hasValidAuth && right.userId);
    if (leftAuth !== rightAuth) return leftAuth ? -1 : 1;
    const scoreDiff = sharedEmailCadastroScore(right, groupEmail) - sharedEmailCadastroScore(left, groupEmail);
    if (scoreDiff !== 0) return scoreDiff;
    const leftRow = left.sourceRow ?? Number.MAX_SAFE_INTEGER;
    const rightRow = right.sourceRow ?? Number.MAX_SAFE_INTEGER;
    if (leftRow !== rightRow) return leftRow - rightRow;
    return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''))
      || String(left.id).localeCompare(String(right.id));
  })[0] ?? null;
}

export function maskSharedEmail(email: string | null | undefined) {
  const value = String(email ?? '').trim().toLowerCase();
  const at = value.indexOf('@');
  if (at < 1) return value || null;
  return `${value.slice(0, 2)}***@${value.slice(at + 1)}`;
}
