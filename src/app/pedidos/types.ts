export type OrderItemRow = {
  id: string;
  itemPosition: number;
  holderName: string | null;
  categoryName: string | null;
  ticketId: string | null;
  ticketStatus: string | null;
  ticketToken: string | null;
  ownershipStatus: string;
};

export type OrderProductItemRow = {
  id: string;
  productName: string | null;
  variant: string | null;
  quantity: number;
  status: string;
};

export type OrderRow = {
  id: string;
  orderNumber: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
  buyerCpf: string;
  eventId: string;
  status: string;
  baseAmount: number;
  discountAmount: number;
  finalAmount: number;
  createdAt: string;
  confirmedAt: string | null;
  paymentMethod: string | null;
  paymentStatus: string;
  itemCount: number;
  issuedTicketCount: number;
  ticketCount: number;
  categoryNames: string[];
  hasDiscount: boolean;
  priceOrigin: string | null;
  items: OrderItemRow[];
  productItems: OrderProductItemRow[];
};

export const ORDER_ORIGIN_VALUES = ["imported_holder", "administrative", "account"] as const;

export type OrderOrigin = (typeof ORDER_ORIGIN_VALUES)[number];

export type OrdersFilterInput = {
  eventId?: string;
  paymentStatus?: string;
  orderStatus?: string;
  origin?: string;
  q?: string;
  page?: string;
};

export const ORDER_PAGE_SIZE = 30;

export function parseOrderOrigin(value?: string | null): OrderOrigin | undefined {
  return ORDER_ORIGIN_VALUES.find((origin) => origin === value);
}
