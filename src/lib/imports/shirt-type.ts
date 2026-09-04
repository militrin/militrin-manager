import { removeAccents, removeDuplicateSpaces } from './normalization.ts';

export function normalizeImportedShirtType(value: string | null | undefined) {
  const original = removeDuplicateSpaces(String(value ?? ''));
  const key = removeAccents(original).toLowerCase().replace(/\s+/g, ' ').trim();
  if (['babylook', 'baby look', 'feminina', 'feminino'].includes(key)) return 'Babylook';
  if (key === 'camiseta') return 'Camiseta';
  return original || null;
}
