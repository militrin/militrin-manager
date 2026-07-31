export type CheckoutPricingGender = 'male' | 'female';

type GenderResolutionInput = {
  itemGender?: unknown;
  requestGender?: unknown;
  buyerGender?: unknown;
};

export function normalizePricingGenderInput(value: unknown): CheckoutPricingGender | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();

  if (normalized === 'male' || normalized === 'masculino' || normalized === 'm') {
    return 'male';
  }

  if (normalized === 'female' || normalized === 'feminino' || normalized === 'f') {
    return 'female';
  }

  return null;
}

export function resolvePricingGender(input: GenderResolutionInput): CheckoutPricingGender | null {
  return (
    normalizePricingGenderInput(input.itemGender)
    ?? normalizePricingGenderInput(input.requestGender)
    ?? normalizePricingGenderInput(input.buyerGender)
    ?? null
  );
}

export function sumCheckoutItemTotals(items: Array<{ unitPrice?: number; discountAmount?: number; finalAmount?: number }>) {
  return items.reduce(
    (acc, item) => {
      acc.original += Number(item.unitPrice ?? 0);
      acc.discount += Number(item.discountAmount ?? 0);
      acc.total += Number(item.finalAmount ?? 0);
      return acc;
    },
    { original: 0, discount: 0, total: 0 },
  );
}
