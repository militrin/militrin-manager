export type OrderItemSnapshot = {
  id: string;
  participantId: string | null;
  participantName: string | null;
  categoryName: string | null;
  batchName: string | null;
  shirtType: string | null;
  shirtSize: string | null;
  ticketToken: string | null;
  ticketStatus: string | null;
};

export type OrderAggregateSnapshot = {
  orderId: string;
  orderNumber: string;
  status: string;
  baseAmount: number;
  discountAmount: number;
  finalAmount: number;
  items: OrderItemSnapshot[];
};

export function buildLegacyOrderAggregate(input: {
  orderId: string;
  orderNumber: string;
  status: string;
  baseAmount: number;
  discountAmount: number;
  finalAmount: number;
  participant?: {
    id?: string | null;
    full_name?: string | null;
    shirt_type?: string | null;
    shirt_size?: string | null;
    ticket_categories?: unknown;
    registration_batches?: unknown;
  } | null;
  tickets?: Array<{
    token?: string | null;
    status?: string | null;
    participant_id?: string | null;
  }>;
}): OrderAggregateSnapshot {
  const fallbackItem: OrderItemSnapshot = {
    id: `legacy-${input.orderId}`,
    participantId: input.participant?.id ? String(input.participant.id) : null,
    participantName: input.participant?.full_name ? String(input.participant.full_name) : null,
    categoryName: relationName(input.participant?.ticket_categories),
    batchName: relationName(input.participant?.registration_batches),
    shirtType: input.participant?.shirt_type ? String(input.participant.shirt_type) : null,
    shirtSize: input.participant?.shirt_size ? String(input.participant.shirt_size) : null,
    ticketToken: null,
    ticketStatus: null,
  };

  const ticketItems = (input.tickets ?? []).map((ticket, index) => ({
    id: `${input.orderId}-ticket-${index + 1}`,
    participantId: ticket.participant_id ? String(ticket.participant_id) : fallbackItem.participantId,
    participantName: fallbackItem.participantName,
    categoryName: fallbackItem.categoryName,
    batchName: fallbackItem.batchName,
    shirtType: fallbackItem.shirtType,
    shirtSize: fallbackItem.shirtSize,
    ticketToken: ticket.token ? String(ticket.token) : null,
    ticketStatus: ticket.status ? String(ticket.status) : null,
  }));

  return {
    orderId: input.orderId,
    orderNumber: input.orderNumber,
    status: input.status,
    baseAmount: input.baseAmount,
    discountAmount: input.discountAmount,
    finalAmount: input.finalAmount,
    items: ticketItems.length > 0 ? ticketItems : [fallbackItem],
  };
}

function relationName(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value[0] as Record<string, unknown> | undefined;
    return first?.name ? String(first.name) : null;
  }
  if (value && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    return objectValue.name ? String(objectValue.name) : null;
  }
  return null;
}
