export const PAYMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Pendente",
  paid: "Confirmado",
  expired: "Expirado",
  cancelled: "Cancelado",
  refunded: "Reembolsado",
};

export type UpdatePaymentStatusInput = {
  participantId: string;
  paymentId: string;
  expectedCurrentStatus: string;
  newStatus: string;
  reason: string;
};
