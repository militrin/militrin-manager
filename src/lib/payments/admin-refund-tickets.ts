export type AdminRefundTicketKitStatus = "delivered" | "pending" | "cancelled" | "none";

export type AdminRefundTicketView = {
  id: string;
  code: string;
  holderName: string;
  status: string;
  usedAt: string | null;
  kitStatus: AdminRefundTicketKitStatus;
  blocker: "used" | "checkin" | "kit_delivered" | null;
  cancellable: boolean;
};

export function classifyAdminRefundTicket(input: {
  id: string;
  token?: string | null;
  status?: string | null;
  usedAt?: string | null;
  holderName?: string | null;
  kitStatuses?: string[];
}): AdminRefundTicketView {
  const status = String(input.status ?? "").trim().toLowerCase();
  const usedAt = input.usedAt ?? null;
  const kitStatuses = (input.kitStatuses ?? []).map((value) => String(value).toLowerCase());
  const kitStatus: AdminRefundTicketKitStatus = kitStatuses.includes("delivered")
    ? "delivered"
    : kitStatuses.some((value) => value !== "cancelled")
      ? "pending"
      : kitStatuses.length
        ? "cancelled"
        : "none";

  let blocker: AdminRefundTicketView["blocker"] = null;
  if (status === "used" || usedAt) blocker = status === "used" ? "used" : "checkin";
  else if (kitStatus === "delivered") blocker = "kit_delivered";

  const alreadyCancelled = status === "cancelled";
  return {
    id: input.id,
    code: `#${String(input.token ?? input.id).slice(0, 8).toUpperCase()}`,
    holderName: input.holderName?.trim() || "Titular não informado",
    status,
    usedAt,
    kitStatus,
    blocker,
    cancellable: !alreadyCancelled && !blocker,
  };
}

export function defaultCancelTicketsChecked(tickets: AdminRefundTicketView[]) {
  return tickets.some((ticket) => ticket.cancellable);
}
