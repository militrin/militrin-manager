import { calculateAgeAtEventDate } from '../utils/date.ts';

export type ImportDataIssue = {
  field_code: string;
  issue_type: string;
  message: string;
  blocks_payment: boolean;
  blocks_ticket_issuance: boolean;
  blocks_checkin: boolean;
  blocks_kit_delivery: boolean;
};

export type ImportOption = {
  id: string;
  name: string;
};

export type IdentityCandidate = {
  id: string;
  fullName: string;
  cpf: string | null;
  email?: string | null;
  phone?: string | null;
};

export function normalizeComparableLabel(value: string | null | undefined) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeCpfDigits(value: string | null | undefined) {
  return String(value ?? '').replace(/\D/g, '');
}

export function isValidCpf(value: string | null | undefined) {
  const cpf = normalizeCpfDigits(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;

  const digits = cpf.split('').map(Number);
  const checkDigit = (position: 9 | 10) => {
    const factor = position + 1;
    const sum = digits
      .slice(0, position)
      .reduce((total, digit, index) => total + digit * (factor - index), 0);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  return digits[9] === checkDigit(9) && digits[10] === checkDigit(10);
}

export function parseIsoDate(value: string | null | undefined) {
  const input = String(value ?? '').trim();
  const match = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;

  return date;
}

// Wrapper fino sobre a fonte canônica única de idade-na-data-do-evento
// (src/lib/utils/date.ts) -- mantido aqui com esse nome/assinatura só para
// não obrigar os chamadores existentes (importacoes/actions.ts, testes) a
// mudar, mas o cálculo em si (ano/mês/dia, fuso do evento) vive só no
// helper canônico, nunca duplicado.
export function calculateAgeAtDate(birthDate: string, referenceDate: string) {
  return calculateAgeAtEventDate(birthDate, referenceDate);
}

export function resolveImportOption(
  input: string | null | undefined,
  options: ImportOption[],
) {
  const requested = normalizeComparableLabel(input);
  if (!requested) {
    return options.length === 1
      ? { option: options[0], reason: 'single_available' as const }
      : { option: null, reason: 'missing' as const };
  }

  const matches = options.filter((option) => normalizeComparableLabel(option.name) === requested);
  return matches.length === 1
    ? { option: matches[0], reason: 'exact_match' as const }
    : { option: null, reason: matches.length > 1 ? 'ambiguous' as const : 'not_found' as const };
}

export function resolveImportOptionWithDefault(input: string | null | undefined, options: ImportOption[], defaultId: string | null | undefined) {
  const requested = normalizeComparableLabel(input);
  if (requested) {
    const matches = options.filter((option) => normalizeComparableLabel(option.name) === requested);
    if (matches.length === 1) return { option: matches[0], reason: 'exact_match' as const, source: 'explicit' as const };
    if (matches.length > 1) return { option: null, reason: 'ambiguous' as const, source: 'unresolved' as const };
  }
  const fallback = defaultId ? options.find((option) => option.id === defaultId) ?? null : null;
  if (fallback) return { option: fallback, reason: 'batch_default' as const, source: 'default' as const };
  return resolveImportOption(input, options);
}

export function hasTicketBlockingIssues(issues: ImportDataIssue[]) {
  return issues.some((issue) => issue.blocks_ticket_issuance || issue.blocks_payment);
}

export function matchCurrentImportIdentity(
  row: { cpf: string | null; fullName: string; email?: string | null; phone?: string | null },
  candidates: IdentityCandidate[],
) {
  if (row.cpf && isValidCpf(row.cpf)) {
    const cpfMatches = candidates.filter((candidate) => candidate.cpf && normalizeCpfDigits(candidate.cpf) === normalizeCpfDigits(row.cpf));
    if (cpfMatches.length === 1) return { kind: 'cpf' as const, participantId: cpfMatches[0].id };
    if (cpfMatches.length > 1) return { kind: 'ambiguous_cpf' as const, participantId: null };
  }

  const normalizedName = normalizeComparableLabel(row.fullName);
  const nameMatches = normalizedName
    ? candidates.filter((candidate) => normalizeComparableLabel(candidate.fullName) === normalizedName)
    : [];
  if (nameMatches.length === 1) return { kind: 'name_review' as const, participantId: nameMatches[0].id };
  if (nameMatches.length > 1) return { kind: 'ambiguous_name' as const, participantId: null };
  return { kind: 'new' as const, participantId: null };
}
