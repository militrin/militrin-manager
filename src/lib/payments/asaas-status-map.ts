import type { InternalPaymentStatus } from "@/lib/payments/provider";

/**
 * Todos os valores de `status` que a API do Asaas pode retornar em um
 * pagamento (GET /v3/payments/:id) ou embutir no payload de webhook
 * (`payment.status`), conforme a documentacao oficial em
 * https://docs.asaas.com/reference/retrieve-status-of-a-payment (consultada
 * na implementacao desta fase). Mantido explicito (em vez de `string`) para
 * que o compilador acuse quando a Asaas documentar um novo valor e o mapa
 * abaixo precisar ser atualizado.
 */
export type AsaasPaymentStatus =
  | "PENDING"
  | "RECEIVED"
  | "CONFIRMED"
  | "OVERDUE"
  | "REFUNDED"
  | "RECEIVED_IN_CASH"
  | "REFUND_REQUESTED"
  | "REFUND_IN_PROGRESS"
  | "PARTIALLY_REFUNDED"
  | "CHARGEBACK_REQUESTED"
  | "CHARGEBACK_DISPUTE"
  | "AWAITING_CHARGEBACK_REVERSAL"
  | "DUNNING_REQUESTED"
  | "DUNNING_RECEIVED"
  | "AWAITING_RISK_ANALYSIS";

/**
 * Tabela canonica Asaas -> Militrin (status interno de payment). Nenhuma tela
 * ou RPC deve interpretar a string de status da Asaas diretamente -- sempre
 * passar por esta funcao.
 *
 * | Status Asaas                  | status interno payment | efeito em order/order_items/ticket                          |
 * |--------------------------------|-------------------------|--------------------------------------------------------------|
 * | PENDING                        | pending                 | nenhum (aguardando pagamento)                                 |
 * | AWAITING_RISK_ANALYSIS         | processing               | nenhum (nao emite ticket ainda)                               |
 * | RECEIVED                       | paid                     | confirma order/order_items, emite ticket                      |
 * | CONFIRMED                      | paid                     | confirma order/order_items, emite ticket                      |
 * | RECEIVED_IN_CASH                | paid                     | confirma order/order_items, emite ticket                      |
 * | OVERDUE                        | expired                  | expira order/order_items pendentes (nunca emite ticket)       |
 * | REFUND_REQUESTED               | processing               | nenhum ainda -- so sinaliza, nao desfaz ticket                |
 * | REFUND_IN_PROGRESS             | processing               | nenhum ainda -- so sinaliza, nao desfaz ticket                |
 * | REFUNDED                       | refunded                 | cancela ticket/order_item preservando historico (nao reabre)  |
 * | PARTIALLY_REFUNDED              | refunded                 | idem REFUNDED nesta fase (decisao de negocio fina fica p/ F2) |
 * | CHARGEBACK_REQUESTED            | chargeback               | apenas sinaliza -- nao cancela ticket automaticamente         |
 * | CHARGEBACK_DISPUTE               | chargeback               | apenas sinaliza -- nao cancela ticket automaticamente         |
 * | AWAITING_CHARGEBACK_REVERSAL    | chargeback               | apenas sinaliza -- nao cancela ticket automaticamente         |
 * | DUNNING_REQUESTED               | expired                  | informativo (cobranca ja estava OVERDUE antes de entrar aqui) |
 * | DUNNING_RECEIVED                | expired                  | informativo (cobranca ja estava OVERDUE antes de entrar aqui) |
 *
 * Regras fixas exigidas pela Fase 1:
 * - Status aprovado (RECEIVED/CONFIRMED/RECEIVED_IN_CASH) SEMPRE converge para 'paid'.
 * - Nenhum status pendente ou de risco emite ticket.
 * - OVERDUE nunca emite ticket.
 * - Estorno/chargeback nunca reabrem nem apagam historico -- so cancelam para frente.
 *
 * Cartao parcelado (docs.asaas.com cobranças via cartão + webhook events):
 * - `PAYMENT_CONFIRMED` / `PAYMENT_RECEIVED` em QUALQUER parcela = aprovacao da
 *   venda. O ingresso e emitido nesse momento, nao quando todas as parcelas
 *   futuras forem recebidas.
 * - `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED` e tentativa recusada; `payment.status`
 *   costuma permanecer PENDING. Nao mapeia para failed comercial.
 * - Parcelas seguintes do mesmo installment so atualizam `payment_gateway_charges`.
 *
 * Limitacao conhecida (sandbox homolog): recusa sincrona de cartao pode
 * manter a cobranca PENDING sem emitir PAYMENT_CREDIT_CARD_CAPTURE_REFUSED.
 * Nao marcar payment failed, nao inferir recusa por tempo. UI usa mensagem
 * neutra ate o evento chegar; o ticket so sai em CONFIRMED/RECEIVED.
 */
const ASAAS_STATUS_MAP: Record<AsaasPaymentStatus, InternalPaymentStatus> = {
  PENDING: "pending",
  AWAITING_RISK_ANALYSIS: "processing",
  RECEIVED: "paid",
  CONFIRMED: "paid",
  RECEIVED_IN_CASH: "paid",
  OVERDUE: "expired",
  REFUND_REQUESTED: "processing",
  REFUND_IN_PROGRESS: "processing",
  REFUNDED: "refunded",
  PARTIALLY_REFUNDED: "refunded",
  CHARGEBACK_REQUESTED: "chargeback",
  CHARGEBACK_DISPUTE: "chargeback",
  AWAITING_CHARGEBACK_REVERSAL: "chargeback",
  DUNNING_REQUESTED: "expired",
  DUNNING_RECEIVED: "expired",
};

/**
 * Converte um status cru da Asaas (string, possivelmente desconhecido se a
 * Asaas introduzir um novo valor) para o status interno Militrin. Um valor
 * fora da tabela nunca deve virar 'paid' silenciosamente -- cai em
 * 'processing' e deve ser investigado manualmente.
 */
export function mapAsaasPaymentStatus(rawStatus: string | null | undefined): InternalPaymentStatus {
  const normalized = String(rawStatus ?? "").trim().toUpperCase();
  if (normalized in ASAAS_STATUS_MAP) {
    return ASAAS_STATUS_MAP[normalized as AsaasPaymentStatus];
  }
  return "processing";
}

export function isKnownAsaasPaymentStatus(rawStatus: string | null | undefined): rawStatus is AsaasPaymentStatus {
  return String(rawStatus ?? "").trim().toUpperCase() in ASAAS_STATUS_MAP;
}

export const ASAAS_CARD_CAPTURE_REFUSED_EVENT = "PAYMENT_CREDIT_CARD_CAPTURE_REFUSED";
export const ASAAS_PAYMENT_DELETED_EVENT = "PAYMENT_DELETED";

export function normalizeAsaasEventType(rawEventType: string | null | undefined): string {
  return String(rawEventType ?? "").trim().toUpperCase();
}

export function isAsaasCardCaptureRefusedEvent(rawEventType: string | null | undefined): boolean {
  return normalizeAsaasEventType(rawEventType) === ASAAS_CARD_CAPTURE_REFUSED_EVENT;
}

export function isAsaasPaymentDeletedEvent(rawEventType: string | null | undefined): boolean {
  return normalizeAsaasEventType(rawEventType) === ASAAS_PAYMENT_DELETED_EVENT;
}
