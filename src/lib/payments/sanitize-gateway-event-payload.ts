/**
 * Recorte minimo do webhook Asaas para persistir em
 * payment_gateway_events.payload. Suficiente para retry, status e
 * reconciliacao (id do evento, id da cobranca, status, valor, referencia).
 * Nunca inclui customer, CPF, e-mail, PIX copia-e-cola, QR ou tokens.
 */
export function sanitizePaymentGatewayEventPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const root = payload as Record<string, unknown>;
  const payment =
    root.payment && typeof root.payment === "object"
      ? (root.payment as Record<string, unknown>)
      : {};

  return {
    id: root.id ?? null,
    event: root.event ?? null,
    dateCreated: root.dateCreated ?? null,
    payment: {
      id: payment.id ?? null,
      status: payment.status ?? null,
      value: payment.value ?? null,
      netValue: payment.netValue ?? null,
      paymentDate: payment.paymentDate ?? null,
      dueDate: payment.dueDate ?? null,
      billingType: payment.billingType ?? null,
      externalReference: payment.externalReference ?? null,
    },
  };
}
