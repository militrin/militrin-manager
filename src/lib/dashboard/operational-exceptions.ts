import { isOperationalTicketStatus } from "./operational-shirt-demand";

type KitLink = { kit_item_id?: unknown; status?: unknown };
type TicketLike = {
  id?: unknown;
  event_id?: unknown;
  status?: unknown;
  used_at?: unknown;
};

export function ticketHasCheckin(ticket: Pick<TicketLike, "used_at" | "status">) {
  return Boolean(ticket.used_at) || String(ticket.status ?? "") === "used";
}

export function ticketHasCompleteRequiredKit(
  ticket: Pick<TicketLike, "id" | "event_id">,
  requiredKitByEvent: Map<string, string[]>,
  kitsByTicket: Map<string, KitLink[]>,
) {
  const required = requiredKitByEvent.get(String(ticket.event_id ?? "")) ?? [];
  const linked = kitsByTicket.get(String(ticket.id ?? "")) ?? [];
  return required.length > 0 && required.every((id) =>
    linked.some((kit) => String(kit.kit_item_id) === id && kit.status === "delivered"),
  );
}

/** Kit completo entregue AND check-in pendente. Nunca KPI kits − KPI check-ins. */
export function isKitDeliveredWithoutCheckin(
  ticket: TicketLike,
  requiredKitByEvent: Map<string, string[]>,
  kitsByTicket: Map<string, KitLink[]>,
) {
  return isOperationalTicketStatus(ticket.status)
    && ticketHasCompleteRequiredKit(ticket, requiredKitByEvent, kitsByTicket)
    && !ticketHasCheckin(ticket);
}

export function isCheckinWithoutCompleteKit(
  ticket: TicketLike,
  requiredKitByEvent: Map<string, string[]>,
  kitsByTicket: Map<string, KitLink[]>,
) {
  const required = requiredKitByEvent.get(String(ticket.event_id ?? "")) ?? [];
  return isOperationalTicketStatus(ticket.status)
    && required.length > 0
    && ticketHasCheckin(ticket)
    && !ticketHasCompleteRequiredKit(ticket, requiredKitByEvent, kitsByTicket);
}

export function isWristbandLinkedWithoutCheckin(
  ticket: TicketLike,
  hasActiveWristband: boolean,
  wristbandEnabled: boolean,
) {
  return wristbandEnabled
    && hasActiveWristband
    && isOperationalTicketStatus(ticket.status)
    && !ticketHasCheckin(ticket);
}

export function isCheckinWithoutRequiredWristband(
  ticket: TicketLike,
  hasActiveWristband: boolean,
  wristbandRequiredForCheckin: boolean,
) {
  return wristbandRequiredForCheckin
    && ticketHasCheckin(ticket)
    && isOperationalTicketStatus(ticket.status)
    && !hasActiveWristband;
}

export function operationsTicketHref(eventId: string | null | undefined, ticketId: string, exception?: "kit_without_checkin") {
  const params = new URLSearchParams();
  if (eventId && eventId !== "all") params.set("eventId", eventId);
  if (exception === "kit_without_checkin") {
    params.set("kitStatus", "delivered");
    params.set("checkinStatus", "pending");
  }
  params.set("focusTicket", ticketId);
  return `/operacoes?${params.toString()}`;
}
