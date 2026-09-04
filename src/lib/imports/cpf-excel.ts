import { isValidCpf, normalizeCpfDigits } from './import-row-validation.ts';

export type CpfCellKind = 'text' | 'number' | 'date' | 'empty' | 'unknown';

export type ImportedCpfClassification = {
  digits: string;
  canonical: string | null;
  excelCandidate: string | null;
  kind: 'valid' | 'excel_leading_zero' | 'invalid' | 'missing';
  original: string | null;
  cellKind: CpfCellKind;
};

export function classifyImportedCpf(
  rawValue: string | null | undefined,
  cellKind: CpfCellKind = 'unknown',
): ImportedCpfClassification {
  const original = rawValue == null ? null : String(rawValue).trim() || null;
  const digits = normalizeCpfDigits(original);
  if (!digits) {
    return { digits: '', canonical: null, excelCandidate: null, kind: 'missing', original, cellKind };
  }
  if (isValidCpf(digits)) {
    return { digits, canonical: digits, excelCandidate: null, kind: 'valid', original, cellKind };
  }
  if (digits.length === 10) {
    const candidate = `0${digits}`;
    if (isValidCpf(candidate)) {
      return {
        digits,
        canonical: null,
        excelCandidate: candidate,
        kind: 'excel_leading_zero',
        original,
        cellKind,
      };
    }
  }
  return { digits, canonical: null, excelCandidate: null, kind: 'invalid', original, cellKind };
}
