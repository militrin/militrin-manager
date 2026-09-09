export const LEGACY_PRICE_ORIGINS = ['legacy_unknown', 'legacy_provided'] as const;
export const PRICE_ORIGINS = ['catalog', ...LEGACY_PRICE_ORIGINS] as const;

export type PriceOrigin = (typeof PRICE_ORIGINS)[number];
export type LegacyPriceStatus = 'unknown' | 'provided';

export type LegacyImportPrice = {
  priceOrigin: Extract<PriceOrigin, 'legacy_unknown' | 'legacy_provided'>;
  legacyPriceStatus: LegacyPriceStatus;
  amount: number | null;
};

/**
 * Importacao legada nunca usa o catalogo atual como preco historico.
 * amount 0 so existe depois, como placeholder NOT NULL no banco, e nunca
 * significa cortesia/gratuito.
 */
export function resolveLegacyImportPrice(sourceAmount: number | null | undefined): LegacyImportPrice {
  if (sourceAmount == null) {
    return {
      priceOrigin: 'legacy_unknown',
      legacyPriceStatus: 'unknown',
      amount: null,
    };
  }

  return {
    priceOrigin: 'legacy_provided',
    legacyPriceStatus: 'provided',
    amount: sourceAmount,
  };
}

export function isLegacyImportPriceOrigin(value: string | null | undefined) {
  return value === 'legacy_unknown' || value === 'legacy_provided';
}

/**
 * Importacao preserva a compra historica. Genero vazio nao inventa preco
 * de catalogo e nao abre missing_required_for_pricing.
 * Checkout/venda nova continua em src/lib/checkout/pricing.ts.
 */
export function importShouldCreatePricingGenderIssue(input: {
  amount: number | null | undefined;
  malePrice?: number | null;
  femalePrice?: number | null;
  gender?: string | null;
}) {
  if (isLegacyImportPriceOrigin(resolveLegacyImportPrice(input.amount).priceOrigin)) {
    return false;
  }

  return input.malePrice != null
    && input.femalePrice != null
    && Number(input.malePrice) !== Number(input.femalePrice)
    && !input.gender;
}

export function formatImportedHistoricalAmount(
  amount: number | null | undefined,
  priceOrigin?: string | null,
) {
  if (priceOrigin === 'legacy_unknown') return 'Não informado';
  if (amount == null) return 'Não informado';
  return Number(amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
