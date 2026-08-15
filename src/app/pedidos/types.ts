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
  ticketCount: number;
  categoryNames: string[];
  hasDiscount: boolean;
  items: OrderItemRow[];
};

export type OrdersFilterInput = {
  eventId?: string;
  paymentStatus?: string;
  orderStatus?: string;
  q?: string;
  page?: string;
};

export const ORDER_PAGE_SIZE = 30;
