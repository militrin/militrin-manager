export const DEFAULT_MAX_TICKETS_PER_ORDER = 10;

export const ORDER_ITEM_STATUS = [
  'reserved',
  'confirmed',
  'cancelled',
  'refunded',
] as const;

export type OrderItemStatus = (typeof ORDER_ITEM_STATUS)[number];
