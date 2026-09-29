/**
 * Quem a Central ainda pode listar como "inscrição sem ingresso".
 *
 * A decisão usa o EVENTO INTEIRO, nunca a página corrente de tickets.
 * OWNER ≠ TITULAR: owner_user_id isolado não entra. Nome/ILIKE tampouco.
 *
 * Relacoes determinísticas:
 * 1. tickets.participant_id
 * 2. order_items.participant_id
 * 3. orders.participant_id quando o pedido já tem ticket operacional
 * 4. tickets.intended_owner_contact_id → participants.registration_contact_id
 */

export type TicketRepresentationReason =
  | "tickets.participant_id"
  | "order_items.participant_id"
  | "orders.participant_id"
  | "tickets.intended_owner_contact_id";

export type FallbackParticipant = {
  id: string;
  registration_contact_id?: string | null;
  registration_status?: string | null;
};

export type FallbackTicket = {
  participant_id?: string | null;
  order_id?: string | null;
  intended_owner_contact_id?: string | null;
  status?: string | null;
};

export type FallbackOrderItem = {
  participant_id?: string | null;
};

export type FallbackOrder = {
  id: string;
  participant_id?: string | null;
};

const OPERATIONAL_TICKET_STATUSES = new Set(["active", "used"]);

function id(value: string | null | undefined) {
  const next = String(value ?? "").trim();
  return next || null;
}

export function isOperationalTicketStatus(status: string | null | undefined) {
  return OPERATIONAL_TICKET_STATUSES.has(String(status ?? "").trim().toLowerCase());
}

function addReason(
  represented: Map<string, TicketRepresentationReason[]>,
  participantId: string | null,
  reason: TicketRepresentationReason,
) {
  if (!participantId) return;
  const current = represented.get(participantId) ?? [];
  if (!current.includes(reason)) current.push(reason);
  represented.set(participantId, current);
}

export function participantTicketRepresentation(input: {
  tickets: FallbackTicket[];
  orderItems: FallbackOrderItem[];
  orders: FallbackOrder[];
  participants: FallbackParticipant[];
}): Map<string, TicketRepresentationReason[]> {
  const represented = new Map<string, TicketRepresentationReason[]>();
  const operationalTickets = input.tickets.filter((ticket) => isOperationalTicketStatus(ticket.status));

  for (const ticket of input.tickets) {
    addReason(represented, id(ticket.participant_id), "tickets.participant_id");
  }

  for (const item of input.orderItems) {
    addReason(represented, id(item.participant_id), "order_items.participant_id");
  }

  const ordersWithOperationalTicket = new Set(
    operationalTickets.map((ticket) => id(ticket.order_id)).filter((orderId): orderId is string => Boolean(orderId)),
  );
  for (const order of input.orders) {
    if (!ordersWithOperationalTicket.has(order.id)) continue;
    addReason(represented, id(order.participant_id), "orders.participant_id");
  }

  const intendedContacts = new Set(
    operationalTickets
      .map((ticket) => id(ticket.intended_owner_contact_id))
      .filter((contactId): contactId is string => Boolean(contactId)),
  );
  for (const participant of input.participants) {
    const contactId = id(participant.registration_contact_id);
    if (!contactId || !intendedContacts.has(contactId)) continue;
    addReason(represented, id(participant.id), "tickets.intended_owner_contact_id");
  }

  return represented;
}

export function participantIdsRepresentedByTickets(input: {
  tickets: FallbackTicket[];
  orderItems: FallbackOrderItem[];
  orders: FallbackOrder[];
  participants: FallbackParticipant[];
}): Set<string> {
  return new Set(participantTicketRepresentation(input).keys());
}

export function withoutTicketFallbackParticipants<T extends { id?: string | null; registration_status?: string | null }>(
  participants: T[],
  represented: Set<string>,
): T[] {
  return participants.filter((participant) => {
    const participantId = id(participant.id);
    if (!participantId) return false;
    if (String(participant.registration_status ?? "").trim().toLowerCase() === "cancelled") return false;
    return !represented.has(participantId);
  });
}
