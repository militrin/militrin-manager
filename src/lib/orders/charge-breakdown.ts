export type OrderChargeBreakdown = {
  itemsAmount: number;
  customerFee: number;
  chargedAmount: number;
  hasCustomerFee: boolean;
};

function moneyNumber(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

// Composição financeira já persistida. Nunca recalcula percentual de taxa.
export function orderChargeBreakdown(input: {
  itemsAmount?: unknown;
  customerFee?: unknown;
  chargedAmount?: unknown;
}): OrderChargeBreakdown {
  const itemsAmount = moneyNumber(input.itemsAmount);
  const customerFee = moneyNumber(input.customerFee);
  const chargedAmount = input.chargedAmount == null || input.chargedAmount === ''
    ? itemsAmount + customerFee
    : moneyNumber(input.chargedAmount);
  return {
    itemsAmount,
    customerFee,
    chargedAmount,
    hasCustomerFee: customerFee > 0,
  };
}
