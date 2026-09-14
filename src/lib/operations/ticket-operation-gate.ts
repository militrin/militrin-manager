import {
  resolveOperationalPaymentState,
  type OperationalPaymentState,
} from "./payment-operational-state.ts";

export type TicketOperationGate = {
  canOperate: boolean;
  blockReason: string | null;
  paymentState: OperationalPaymentState;
};

function normalize(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Gate operacional de um INGRESSO já emitido.
 *
 * Fonte canônica de cancelamento: tickets.status.
 * participants.registration_status NÃO entra aqui — reserva expirada / checkout
 * antigo pode deixar a inscrição "cancelled" sem cancelar o ticket ativo.
 */
export function resolveTicketOperationGate(input: {
  ticketStatus?: string | null;
  paymentStatus?: string | null;
  paymentMethod?: string | null;
  priceOrigin?: string | null;
}): TicketOperationGate {
  const paymentState = resolveOperationalPaymentState({
    paymentStatus: input.paymentStatus,
    paymentMethod: input.paymentMethod,
    priceOrigin: input.priceOrigin,
    ticketStatus: input.ticketStatus,
  });

  return {
    canOperate: paymentState.operational,
    blockReason: paymentState.operational ? null : paymentState.blockReason,
    paymentState,
  };
}

export function isCancelledTicketStatus(ticketStatus: string | null | undefined) {
  const status = normalize(ticketStatus);
  return status === "cancelled" || status === "canceled";
}

export type RemainingTurboTicketAction = "wristband" | "deliver_and_checkin" | "checkin" | null;

/**
 * Próxima ação da estação Turbo para um ingresso já resolvido.
 * Check-in feito continua encerrando o fluxo (semântica existente).
 * Kit entregue + check-in pendente ainda oferece a ação de check-in.
 */
export function remainingTurboTicketAction(input: {
  ticketStatus?: string | null;
  checkinStatus?: string | null;
  canOperate: boolean;
  blockReason?: string | null;
  kitPending: boolean;
  wristbandRequired: boolean;
  extraBlockers?: string[];
}): RemainingTurboTicketAction {
  if (isCancelledTicketStatus(input.ticketStatus)) return null;
  if (input.checkinStatus === "done") return null;
  if (!input.canOperate) return null;
  if (input.extraBlockers && input.extraBlockers.length > 0) return null;
  if (input.wristbandRequired) return "wristband";
  if (input.kitPending) return "deliver_and_checkin";
  return "checkin";
}
