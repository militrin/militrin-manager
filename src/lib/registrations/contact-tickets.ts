export type ContactTicketLink = {
  ticketId: string;
  eventId: string;
  eventName: string;
  participantContactId?: string | null;
  orderItemContactId?: string | null;
  ownerUserId?: string | null;
};

export type ContactTicketRole = "owner" | "holder";

export type ContactTicketGroup<T extends ContactTicketLink = ContactTicketLink> = {
  eventId: string;
  eventName: string;
  tickets: T[];
};

export function contactIdForTicket(ticket: ContactTicketLink) {
  return ticket.orderItemContactId ?? ticket.participantContactId ?? null;
}

export function rolesForContactTicket(ticket: ContactTicketLink, contactId: string, linkedUserIds: Iterable<string>) {
  const roles: ContactTicketRole[] = [];
  const users = linkedUserIds instanceof Set ? linkedUserIds : new Set(linkedUserIds);
  if (ticket.ownerUserId && users.has(ticket.ownerUserId)) roles.push("owner");
  if (contactIdForTicket(ticket) === contactId) roles.push("holder");
  return roles;
}

export function contactTicketRoleLabel(roles: ContactTicketRole[]) {
  if (roles.includes("owner") && roles.includes("holder")) return "Proprietário e titular";
  if (roles.includes("owner")) return "Proprietário";
  return "Titular";
}

export function ticketsForContact<T extends ContactTicketLink>(tickets: T[], contactId: string) {
  const byTicketId = new Map<string, T>();
  for (const ticket of tickets) {
    if (contactIdForTicket(ticket) === contactId) byTicketId.set(ticket.ticketId, ticket);
  }
  return Array.from(byTicketId.values());
}

export function groupContactTickets<T extends ContactTicketLink>(tickets: T[]) {
  const groups = new Map<string, ContactTicketGroup<T>>();
  for (const ticket of tickets) {
    const current = groups.get(ticket.eventId) ?? {
      eventId: ticket.eventId,
      eventName: ticket.eventName,
      tickets: [],
    };
    current.tickets.push(ticket);
    groups.set(ticket.eventId, current);
  }
  return Array.from(groups.values());
}

export function resolveTicketChoice<T extends ContactTicketLink>(tickets: T[]) {
  if (tickets.length === 0) return { kind: "none" as const };
  if (tickets.length === 1) return { kind: "single" as const, ticket: tickets[0] };
  return { kind: "multiple" as const, tickets };
}
