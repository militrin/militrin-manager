import type { SupabaseClient } from "@supabase/supabase-js";

export const INACTIVE_TICKET_STATUSES = ["cancelled", "canceled", "void", "voided"] as const;

export type ActiveTicketHolderState = {
  hasActiveTicket: boolean;
  ticketId: string | null;
};

export function shouldAssignBuyerToNewOrder(assignmentRequested: boolean, hasActiveTicket: boolean) {
  return assignmentRequested && !hasActiveTicket;
}

export function buyerOwnershipModes(quantity: number, assignmentRequested: boolean, hasActiveTicket: boolean) {
  const count=Math.max(1,Math.trunc(quantity));
  const assignFirst=shouldAssignBuyerToNewOrder(assignmentRequested,hasActiveTicket);
  return Array.from({length:count},(_,index)=>assignFirst&&index===0 ? "self" as const : "unassigned" as const);
}

export async function registrationContactHasActiveTicket(
  supabase: SupabaseClient,
  eventId: string,
  registrationContactId: string,
  excludeTicketId?: string | null,
): Promise<ActiveTicketHolderState> {
  let canonical = supabase
    .from("tickets")
    .select("id,order_items!inner(registration_contact_id)")
    .eq("event_id", eventId)
    .eq("order_items.registration_contact_id", registrationContactId)
    .not("status", "in", `(${INACTIVE_TICKET_STATUSES.join(",")})`)
    .limit(1);
  if (excludeTicketId) canonical = canonical.neq("id", excludeTicketId);
  const { data: canonicalRows, error: canonicalError } = await canonical;
  if (canonicalError) throw canonicalError;
  if (canonicalRows?.[0]?.id) return { hasActiveTicket: true, ticketId: String(canonicalRows[0].id) };

  // Compatibilidade ate o backfill completo: o contato pode existir apenas no participant.
  const { data: participants, error: participantError } = await supabase
    .from("participants")
    .select("id")
    .eq("registration_contact_id", registrationContactId);
  if (participantError) throw participantError;
  const participantIds = (participants ?? []).map((row) => String(row.id));
  if (participantIds.length === 0) return { hasActiveTicket: false, ticketId: null };

  let legacy = supabase
    .from("tickets")
    .select("id")
    .eq("event_id", eventId)
    .in("participant_id", participantIds)
    .not("status", "in", `(${INACTIVE_TICKET_STATUSES.join(",")})`)
    .limit(1);
  if (excludeTicketId) legacy = legacy.neq("id", excludeTicketId);
  const { data: legacyRows, error: legacyError } = await legacy;
  if (legacyError) throw legacyError;
  return { hasActiveTicket: Boolean(legacyRows?.[0]?.id), ticketId: legacyRows?.[0]?.id ? String(legacyRows[0].id) : null };
}
