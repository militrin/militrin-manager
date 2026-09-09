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

const IMPORTED_PAYMENT_METHOD_LABELS: Record<ImportedPaymentMethod, string> = {
  pix: 'PIX',
  credit_card: 'Cartão',
  cash: 'Dinheiro',
  courtesy: 'Cortesia',
};

/**
 * Origem vazia permanece desconhecida. Nunca apresenta pix/cortesia/gratuito
 * so porque o CSV nao trouxe forma de pagamento.
 */
export function formatImportedPaymentMethod(value: string | null | undefined) {
  if (!String(value ?? '').trim()) return 'Não informado';
  const method = normalizeImportedPaymentMethod(value);
  if (!method) return 'Não informado';
  return IMPORTED_PAYMENT_METHOD_LABELS[method];
}
