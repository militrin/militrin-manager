import type { ContactAccountState } from "@/lib/account/contact-account-state";

export type ContactTicketLink = {
  ticketId: string;
  eventId: string;
  eventName: string;
  participantContactId?: string | null;
  orderItemContactId?: string | null;
  ownerUserId?: string | null;
  intendedOwnerContactId?: string | null;
};

export type ContactTicketRole = "owner" | "holder" | "intended_owner";

export type ContactTicketGroup<T extends ContactTicketLink = ContactTicketLink> = {
  eventId: string;
  eventName: string;
  tickets: T[];
};

export type TicketHolderAccountKind =
  | "active"
  | "pending_confirmation"
  | "existing_confirmed"
  | "pending_first_access"
  | "unlinked"
  | "attention";

export type TicketIdentityView = {
  holderName: string;
  holderAccountKind: TicketHolderAccountKind;
  holderAccountLabel: string;
  ownerName: string;
  intendedOwnerName: string | null;
};

const CLOSED_ACCOUNT_INVITE_STATUSES = new Set([
  "claimed",
  "revoked",
  "cancelled",
  "canceled",
  "expired",
  "failed",
]);

export function contactIdForTicket(ticket: ContactTicketLink) {
  return ticket.orderItemContactId ?? ticket.participantContactId ?? null;
}

export function rolesForContactTicket(ticket: ContactTicketLink, contactId: string, linkedUserIds: Iterable<string>) {
  const roles: ContactTicketRole[] = [];
  const users = linkedUserIds instanceof Set ? linkedUserIds : new Set(linkedUserIds);
  if (ticket.ownerUserId && users.has(ticket.ownerUserId)) roles.push("owner");
  else if (ticket.intendedOwnerContactId === contactId) roles.push("intended_owner");
  if (contactIdForTicket(ticket) === contactId) roles.push("holder");
  return roles;
}

export function contactTicketRoleLabel(roles: ContactTicketRole[]) {
  if (roles.includes("owner") && roles.includes("holder")) return "Proprietário e titular";
  if (roles.includes("owner")) return "Proprietário";
  if (roles.includes("holder")) return "Titular";
  if (roles.includes("intended_owner")) return "Pretendido";
  return "Titular";
}

export function isPendingFirstAccessInvite(status?: string | null) {
  const value = String(status ?? "").trim().toLowerCase();
  if (!value) return false;
  return !CLOSED_ACCOUNT_INVITE_STATUSES.has(value);
}

export function classifyTicketHolderAccount(input: {
  holderContactUserId?: string | null;
  accountState?: ContactAccountState | null;
  inviteStatus?: string | null;
}): TicketHolderAccountKind {
  if (input.holderContactUserId) return "active";
  if (input.accountState === "active") return "active";
  if (input.accountState === "pending_confirmation") return "pending_confirmation";
  if (input.accountState === "existing_confirmed") return "existing_confirmed";
  if (input.accountState === "attention") return "attention";
  if (isPendingFirstAccessInvite(input.inviteStatus)) return "pending_first_access";
  return "unlinked";
}

export function ticketHolderAccountLabel(kind: TicketHolderAccountKind) {
  if (kind === "active") return "Ativa";
  if (kind === "pending_confirmation") return "Aguardando confirmação";
  if (kind === "existing_confirmed") return "Conta existente";
  if (kind === "pending_first_access") return "Aguardando primeiro acesso";
  if (kind === "attention") return "Requer atenção";
  return "Não vinculada";
}

export function ticketOwnerDisplayName(ownerUserId?: string | null, ownerName?: string | null) {
  if (!ownerUserId) return "Não definido";
  const name = String(ownerName ?? "").trim();
  return name || "Conta vinculada";
}

export function ticketIntendedOwnerDisplayName(input: {
  ownerUserId?: string | null;
  intendedOwnerContactId?: string | null;
  intendedOwnerName?: string | null;
}) {
  if (input.ownerUserId) return null;
  if (!input.intendedOwnerContactId) return null;
  const name = String(input.intendedOwnerName ?? "").trim();
  return name || "Cadastro pretendido";
}

export function buildTicketIdentityView(input: {
  holderName: string;
  holderContactUserId?: string | null;
  holderAccountState?: ContactAccountState | null;
  holderInviteStatus?: string | null;
  ownerUserId?: string | null;
  ownerName?: string | null;
  intendedOwnerContactId?: string | null;
  intendedOwnerName?: string | null;
  ticketStatus?: string | null;
  buyerType?: string | null;
}): TicketIdentityView {
  const holderAccountKind = classifyTicketHolderAccount({
    holderContactUserId: input.holderContactUserId,
    accountState: input.holderAccountState,
    inviteStatus: input.holderInviteStatus,
  });
  return {
    holderName: input.holderName,
    holderAccountKind,
    holderAccountLabel: ticketHolderAccountLabel(holderAccountKind),
    ownerName: ticketOwnerDisplayName(input.ownerUserId, input.ownerName),
    intendedOwnerName: ticketIntendedOwnerDisplayName({
      ownerUserId: input.ownerUserId,
      intendedOwnerContactId: input.intendedOwnerContactId,
      intendedOwnerName: input.intendedOwnerName,
    }),
  };
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
