/**
 * Cadastro ≠ titular.
 *
 * /cadastros lista identidades (conta ou cadastro legítimo), nunca um titular
 * que só existe como nome/holder de ingresso de outra conta.
 *
 * Classes (evidência, não "user_id null"):
 *   A — Auth/user_id presente (conta autenticável)
 *   B — sem user_id + convite pending de primeiro acesso
 *   C — cadastro/importado legítimo (residual visível: não é titular-fantasma)
 *   E — titular-only: sem conta, sem convite pending, holder de ingresso
 *       operacional já owned por outra conta, e sem ingresso próprio
 *       intended_owner ainda não owned (para não esconder C).
 *
 * D (titular textual sem registration_contact, ex. Bruno Gambatto) não gera
 * linha nesta tabela — não há contact para classificar.
 *
 * Não DELETE / não nullar FK nesta camada: E só deixa de aparecer.
 */
import { isOperationalTicketStatus } from "../dashboard/operational-shirt-demand.ts";

export type CadastroListingClass = "A" | "B" | "C" | "E";

export type CadastroListingContact = {
  contactId: string;
  userId?: string | null;
  hasPendingFirstAccessInvite?: boolean;
};

export type CadastroListingTicket = {
  ticketId: string;
  eventId: string;
  status?: string | null;
  ownerUserId?: string | null;
  intendedOwnerContactId?: string | null;
  holderContactId?: string | null;
};

export type CadastroTicketStats = {
  ticketCount: number;
  eventCount: number;
};

export function isCadastroOperationalTicketStatus(status: unknown) {
  return isOperationalTicketStatus(status);
}

export function classifyCadastroListing(
  contact: CadastroListingContact,
  tickets: readonly CadastroListingTicket[],
): CadastroListingClass {
  if (String(contact.userId ?? "").trim()) return "A";
  if (contact.hasPendingFirstAccessInvite) return "B";
  const operational = tickets.filter((ticket) => isCadastroOperationalTicketStatus(ticket.status));
  const hasOwnUnownedTicket = operational.some((ticket) => (
    ticket.intendedOwnerContactId === contact.contactId && !ticket.ownerUserId
  ));
  const holderOfOwnedByOtherAccount = operational.some((ticket) => (
    ticket.holderContactId === contact.contactId
    && Boolean(ticket.ownerUserId)
  ));
  if (holderOfOwnedByOtherAccount && !hasOwnUnownedTicket) return "E";
  return "C";
}

export function cadastroAppearsInListing(listingClass: CadastroListingClass) {
  return listingClass !== "E";
}

export function matchesCadastroListingQuery(
  fields: { name?: string | null; cpf?: string | null; email?: string | null; phone?: string | null },
  query: string,
) {
  const needle = query.trim().toLocaleLowerCase("pt-BR");
  if (!needle) return true;
  return [fields.name, fields.cpf, fields.email, fields.phone]
    .some((value) => String(value ?? "").toLocaleLowerCase("pt-BR").includes(needle));
}

export function countCadastroOwnedOperationalTickets(
  contact: CadastroListingContact,
  tickets: readonly CadastroListingTicket[],
): CadastroTicketStats {
  const userId = String(contact.userId ?? "").trim();
  const operational = tickets.filter((ticket) => isCadastroOperationalTicketStatus(ticket.status));
  const relevant = userId
    ? operational.filter((ticket) => ticket.ownerUserId === userId)
    : operational.filter((ticket) => (
      ticket.intendedOwnerContactId === contact.contactId && !ticket.ownerUserId
    ));
  const ticketIds = new Set(relevant.map((ticket) => ticket.ticketId));
  const eventIds = new Set(relevant.map((ticket) => ticket.eventId));
  return { ticketCount: ticketIds.size, eventCount: eventIds.size };
}

export function visibleCadastroUniverseSize(rawContactCount: number, classECount: number) {
  return Math.max(0, rawContactCount - classECount);
}

export function cadastroHrefForOwnedTicket(input: {
  ownerContactId?: string | null;
  intendedOwnerContactId?: string | null;
  holderContactId?: string | null;
  holderIsListingCadastro?: boolean;
  ticketId?: string | null;
}) {
  if (input.ownerContactId) return `/cadastros/${input.ownerContactId}`;
  if (input.intendedOwnerContactId) return `/cadastros/${input.intendedOwnerContactId}`;
  if (input.holderIsListingCadastro && input.holderContactId) return `/cadastros/${input.holderContactId}`;
  if (input.ticketId) return `/ingressos/${input.ticketId}`;
  return "/cadastros";
}

export function fichaIncludesOwnedTicket(input: {
  listingClass: CadastroListingClass;
  hasUserId: boolean;
  roles: readonly string[];
}) {
  if (input.listingClass === "E") return false;
  if (input.hasUserId) return input.roles.includes("owner");
  return input.roles.includes("owner") || input.roles.includes("intended_owner");
}

export type HolderOnlyTicketPointer = {
  ticketId: string;
  eventId: string;
  status: string | null;
  ownerContactId: string | null;
  ownerUserId: string | null;
};

export function relatedLegacyHolderTickets(
  contactId: string,
  tickets: readonly CadastroListingTicket[],
) {
  return tickets.filter((ticket) => (
    ticket.holderContactId === contactId && isCadastroOperationalTicketStatus(ticket.status)
  ));
}

export function legacyHolderOwnerLookupIds(
  contactId: string,
  tickets: readonly CadastroListingTicket[],
) {
  const related = relatedLegacyHolderTickets(contactId, tickets);
  return {
    ownerUserIds: Array.from(new Set(related.flatMap((ticket) => (
      ticket.ownerUserId ? [ticket.ownerUserId] : []
    )))),
    intendedOwnerIds: Array.from(new Set(related.flatMap((ticket) => (
      ticket.intendedOwnerContactId ? [ticket.intendedOwnerContactId] : []
    )))),
  };
}

export function holderOnlyTicketPointers(
  contactId: string,
  tickets: readonly CadastroListingTicket[],
  ownerContactByUserId: ReadonlyMap<string, string>,
): HolderOnlyTicketPointer[] {
  return relatedLegacyHolderTickets(contactId, tickets).map((ticket) => ({
    ticketId: ticket.ticketId,
    eventId: ticket.eventId,
    status: ticket.status ?? null,
    ownerUserId: ticket.ownerUserId ?? null,
    ownerContactId: ticket.ownerUserId
      ? ownerContactByUserId.get(ticket.ownerUserId) ?? ticket.intendedOwnerContactId ?? null
      : ticket.intendedOwnerContactId ?? null,
  }));
}

export function uniqueLegacyHolderOwnerKeys(pointers: readonly HolderOnlyTicketPointer[]) {
  return Array.from(new Set(pointers.flatMap((pointer) => {
    const key = pointer.ownerContactId ?? pointer.ownerUserId;
    return key ? [key] : [];
  })));
}

export function singleLegacyHolderOwnerContactId(pointers: readonly HolderOnlyTicketPointer[]) {
  if (!pointers.length) return null;
  const contactIds = pointers.map((pointer) => pointer.ownerContactId);
  if (contactIds.some((value) => !value)) return null;
  const unique = new Set(contactIds as string[]);
  return unique.size === 1 ? contactIds[0] : null;
}

export function importIdentityMode(details: unknown): "cadastro" | "textual_holder" {
  if (!details || typeof details !== "object" || Array.isArray(details)) return "cadastro";
  const mode = String((details as Record<string, unknown>).identity_mode ?? "").trim();
  return mode === "textual_holder" ? "textual_holder" : "cadastro";
}
