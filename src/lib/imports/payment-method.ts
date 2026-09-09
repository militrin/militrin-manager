import { removeAccents, removeDuplicateSpaces } from './normalization.ts';

export type ImportedPaymentMethod = 'pix' | 'credit_card' | 'cash' | 'courtesy';

function canonicalizeImportedPaymentMethod(value: string | null | undefined) {
  return removeDuplicateSpaces(removeAccents(String(value ?? ''))).toLowerCase();
}

/**
 * Normaliza o metodo declarado na origem. Nao inventa status financeiro:
 * Cartao/Pix so identificam o meio, nunca pago/pendente/receita.
 */
export function normalizeImportedPaymentMethod(value: string | null | undefined): ImportedPaymentMethod | null {
  const normalized = canonicalizeImportedPaymentMethod(value);
  if (!normalized) return null;
  if (normalized === 'pix') return 'pix';
  if (
    normalized === 'credito'
    || normalized === 'credit_card'
    || normalized === 'credit card'
    || normalized === 'cartao'
    || normalized === 'card'
  ) {
    return 'credit_card';
  }
  if (normalized === 'dinheiro' || normalized === 'cash') return 'cash';
  if (normalized === 'cortesia' || normalized === 'courtesy') return 'courtesy';
  return null;
}
