export const CHECKOUT_STOCK_HOLD_MINUTES = 10;
export const CHECKOUT_STOCK_HOLD_MS = CHECKOUT_STOCK_HOLD_MINUTES * 60 * 1000;

export function checkoutHoldExpiresAt(from = new Date()): Date {
  return new Date(from.getTime() + CHECKOUT_STOCK_HOLD_MS);
}

export function checkoutHoldExpiresAtIso(from = new Date()): string {
  return checkoutHoldExpiresAt(from).toISOString();
}
