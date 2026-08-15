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

export type ZeroPaymentReason = 'courtesy' | 'coupon' | 'free';

export type ZeroPaymentContext = {
  baseAmount: number;
  discountAmount: number;
  finalAmount: number;
  paymentMethod?: string | null;
  couponApplied?: boolean;
};

/**
 * final_amount <= 0 nunca deve, por si so, ser lido como cortesia: um preco
 * final igual a zero pode vir de um ingresso configurado como gratuito, de um
 * cupom aplicado explicitamente, ou (administrativo) de uma cortesia declarada
 * via payment_method. Esta funcao decide qual dos tres representa o pedido.
 */
export function describeZeroPaymentReason(context: ZeroPaymentContext): { reason: ZeroPaymentReason; message: string } | null {
  const finalAmount = Number(context.finalAmount ?? 0);
  if (finalAmount > 0) return null;

  if (context.paymentMethod === 'courtesy') {
    return { reason: 'courtesy', message: 'Cortesia aplicada. Nenhum pagamento será necessário.' };
  }

  const discountAmount = Number(context.discountAmount ?? 0);
  if (context.couponApplied && discountAmount > 0) {
    return { reason: 'coupon', message: 'Cupom aplicado. Nenhum pagamento será necessário.' };
  }

  return { reason: 'free', message: 'Ingresso gratuito. Nenhum pagamento será necessário.' };
}
