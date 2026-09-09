import { ticketDisplayReference } from "@/lib/display-reference";
import { currentSharedEmailPrincipalId, normalizeSharedEmail } from "@/lib/account/shared-email-ownership";
import type { createServerSupabaseClient } from "@/lib/supabase/server";

type ServerSupabase = Awaited<ReturnType<typeof createServerSupabaseClient>>;

function relation(value: unknown) {
  return (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null;
}

export type SharedEmailGroupPerson = {
  id: string;
  name: string;
  pin: string | null;
  ticketCount: number;
  isPrincipal: boolean;
  isHolder: boolean;
  hasValidAuth: boolean;
  userId: string | null;
  inviteStatus: "linked" | "pending" | "none";
};

export type SharedEmailGroupTicket = {
  ticketId: string;
  eventId: string;
  eventName: string;
  code: string;
  holderContactId: string;
  holderName: string;
  categoryName: string;
  status: string;
  intendedOwnerContactId: string | null;
  ownerUserId: string | null;
};

export type SharedEmailGroupView = {
  email: string;
  peopleCount: number;
  ticketCount: number;
  currentPrincipalId: string | null;
  currentPrincipalName: string | null;
  principalUnanimous: boolean;
  accountStatus: "active" | "pending_activation";
  inviteStatusLabel: string;
  people: SharedEmailGroupPerson[];
  tickets: SharedEmailGroupTicket[];
};

export async function loadSharedEmailGroup(
  supabase: ServerSupabase,
  organizationId: string,
  contactId: string,
): Promise<SharedEmailGroupView | null> {
  const { data: contact, error: contactError } = await supabase
    .from("registration_contacts")
    .select("id,full_name,email,organization_id")
    .eq("id", contactId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (contactError) throw contactError;
  const email = normalizeSharedEmail(contact?.email ? String(contact.email) : null);
  if (!contact || !email) return null;

  const { data: peopleRows, error: peopleError } = await supabase
    .from("registration_contacts")
    .select("id,full_name,public_pin,email,user_id")
    .eq("organization_id", organizationId)
    .ilike("email", email);
  if (peopleError) throw peopleError;
  const people = (peopleRows ?? []).filter((row) => normalizeSharedEmail(row.email) === email);
  if (people.length < 2) return null;

  const personIds = people.map((row) => String(row.id));
  const [{ data: ticketRows, error: ticketsError }, { data: inviteRows, error: invitesError }] = await Promise.all([
    supabase
      .from("tickets")
      .select("id,token,status,event_id,owner_user_id,intended_owner_contact_id,participant_id,order_id,order_item_id,events(id,name),orders(order_number,display_number,user_id),order_items(item_position,registration_contact_id,holder_full_name,ticket_categories(name)),participants(registration_contact_id,full_name)")
      .eq("organization_id", organizationId)
      .range(0, 4999),
    supabase
      .from("participant_account_invites")
      .select("registration_contact_id,status")
      .in("registration_contact_id", personIds)
      .eq("status", "pending"),
  ]);
  if (ticketsError) throw ticketsError;
  if (invitesError) throw invitesError;

  const pendingInviteIds = new Set(
    (inviteRows ?? []).map((row) => String(row.registration_contact_id ?? "")).filter(Boolean),
  );
  const personIdSet = new Set(personIds);
  const tickets = (ticketRows ?? []).flatMap((row) => {
    if (["cancelled", "canceled", "void", "voided"].includes(String(row.status ?? ""))) return [];
    const orderItem = relation(row.order_items);
    const participant = relation(row.participants);
    const event = relation(row.events);
    const order = relation(row.orders);
    const category = relation(orderItem?.ticket_categories);
    const holderContactId = participant?.registration_contact_id
      ? String(participant.registration_contact_id)
      : orderItem?.registration_contact_id
        ? String(orderItem.registration_contact_id)
        : "";
    if (!holderContactId || !personIdSet.has(holderContactId)) return [];
    return [{
      ticketId: String(row.id),
      eventId: String(row.event_id),
      eventName: String(event?.name ?? "Evento"),
      code: ticketDisplayReference(order?.display_number, orderItem?.item_position ?? 1, order?.order_number).replace(/^#/, ""),
      holderContactId,
      holderName: String(participant?.full_name ?? orderItem?.holder_full_name ?? "Titular não identificado"),
      categoryName: String(category?.name ?? "Ingresso"),
      status: String(row.status ?? "pending"),
      intendedOwnerContactId: row.intended_owner_contact_id ? String(row.intended_owner_contact_id) : null,
      ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    }];
  });

  const principal = currentSharedEmailPrincipalId(tickets);
  const peopleView: SharedEmailGroupPerson[] = people.map((row) => {
    const id = String(row.id);
    const userId = row.user_id ? String(row.user_id) : null;
    return {
      id,
      name: String(row.full_name ?? "Pessoa"),
      pin: row.public_pin ? String(row.public_pin) : null,
      ticketCount: tickets.filter((ticket) => ticket.holderContactId === id).length,
      isPrincipal: principal.id === id,
      isHolder: tickets.some((ticket) => ticket.holderContactId === id),
      hasValidAuth: Boolean(userId),
      userId,
      inviteStatus: (userId ? "linked" : pendingInviteIds.has(id) ? "pending" : "none") as SharedEmailGroupPerson["inviteStatus"],
    };
  }).sort((left, right) => Number(right.isPrincipal) - Number(left.isPrincipal) || left.name.localeCompare(right.name, "pt-BR"));

  const principalPerson = peopleView.find((person) => person.id === principal.id) ?? null;
  const accountStatus = principalPerson?.hasValidAuth ? "active" : "pending_activation";
  const inviteStatusLabel = !principalPerson
    ? "Conta principal ainda não definida"
    : principalPerson.hasValidAuth
      ? "Conta ativa"
      : principalPerson.inviteStatus === "pending"
        ? "Convite pendente"
        : "Conta ainda não ativada";

  return {
    email,
    peopleCount: peopleView.length,
    ticketCount: tickets.length,
    currentPrincipalId: principal.id,
    currentPrincipalName: principalPerson?.name ?? null,
    principalUnanimous: principal.unanimous,
    accountStatus,
    inviteStatusLabel,
    people: peopleView,
    tickets,
  };
}
