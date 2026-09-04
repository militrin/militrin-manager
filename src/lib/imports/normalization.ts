import { isValidCpf, normalizeCpfDigits, parseIsoDate } from './import-row-validation.ts';

export function removeDuplicateSpaces(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

export function removeAccents(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeForMatch(value: string) {
  return removeDuplicateSpaces(removeAccents(value).toLowerCase());
}

export function normalizeCpf(value: string | null | undefined) {
  const digits = normalizeCpfDigits(value);
  return isValidCpf(digits) ? digits : null;
}

export function maskCpf(cpf: string | null | undefined) {
  const digits = String(cpf ?? '').replace(/\D/g, '');
  if (digits.length !== 11) return '***';
  return `${digits.slice(0, 3)}***${digits.slice(-2)}`;
}

export function normalizePhone(value: string | null | undefined) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  return digits;
}

export function normalizeEmail(value: string | null | undefined) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  const simpleEmailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return simpleEmailRegex.test(normalized) ? normalized : null;
}

export function parseBrDateToISO(value: string | null | undefined) {
  const input = String(value ?? '').trim();
  if (!input) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return parseIsoDate(input) ? input : null;
  }

  const match = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}
