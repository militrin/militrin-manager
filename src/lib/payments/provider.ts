// ============================================================================
// Contrato LEGADO (participant-centric). Mantido tal como estava: e usado
// hoje pelo fluxo de inscricao antigo (generatePublicPixAction, loja solo,
// etc). Nao remover, nao renomear -- FakePaymentProvider e MercadoPagoProvider
// continuam implementando exatamente isto. Novo codigo NAO deve depender
// deste contrato: usar o modelo canonico abaixo.
// ============================================================================

export type PaymentMethod = "pix" | "credit_card" | "cash" | "courtesy";

export type PaymentStatus = "pending" | "paid" | "expired" | "cancelled" | "refunded";

export type PixPayload = {
  pixCode: string;
  pixQrCode: string;
  gatewayPaymentId: string;
  expiresAt: string;
};

export interface PaymentProvider {
  createPix(input: { participantId: string; amount: number; expiresInMinutes: number }): Promise<PixPayload>;
  confirmPayment(input: { participantId: string; method: PaymentMethod }): Promise<{ confirmedAt: string }>;
  cancelPayment(input: { participantId: string; reason?: string }): Promise<{ cancelledAt: string }>;
  refund(input: { participantId: string; reason?: string }): Promise<{ refundedAt: string }>;
}

// ============================================================================
// Contrato CANONICO (Fase 1 Asaas). Modelo orderId/paymentId, multi-provider,
// desacoplado de qualquer formato especifico de gateway. Todo gateway real
// (Asaas, e futuros) implementa `PaymentGatewayProvider`; nenhuma tela ou RPC
// deve depender de tipos/strings especificos de um gateway -- so destes DTOs.
// ============================================================================

export type PaymentProviderName = "fake" | "asaas";

/**
 * Status interno, independente de gateway. Todo `mapXxxPaymentStatus(...)`
 * especifico de provider deve convergir para um destes valores -- nunca
 * expor uma string de status crua de gateway para fora do adapter.
 */
export type InternalPaymentStatus =
  | "pending"
  | "processing"
  | "paid"
  | "expired"
  | "cancelled"
  | "refunded"
  | "chargeback"
  | "failed";

export type PayerInfo = {
  name: string;
  email: string;
  cpfCnpj: string;
  phone?: string;
};

export type CreatePixPaymentInput = {
  organizationId: string;
  orderId: string;
  paymentId: string;
  amount: number;
  dueDate: string; // YYYY-MM-DD
  payer: PayerInfo;
  description?: string;
};

export type CreatePixPaymentResult = {
  providerPaymentId: string;
  status: InternalPaymentStatus;
  pixCode: string;
  pixQrCodeImage: string;
  expiresAt: string;
};

export type CreateCardPaymentInput = {
  organizationId: string;
  orderId: string;
  paymentId: string;
  amount: number;
  dueDate: string; // YYYY-MM-DD
  payer: PayerInfo;
  description?: string;
  /** Parcelas ja decididas pelo Militrin (event_payment_methods). 1 = a vista. */
  installments?: number;
  /** URL de retorno apos a Fatura Asaas. Nao confirma pagamento. */
  successUrl?: string;
};

export type GatewayChargeDraft = {
  providerPaymentId: string;
  gatewayInstallmentId?: string | null;
  installmentNumber: number;
  installmentCount: number;
  amount: number;
};

export type CreateCardPaymentResult = {
  providerPaymentId: string;
  status: InternalPaymentStatus;
  /** URL hospedada do Asaas (invoiceUrl). Nunca contem PAN/CVV. */
  checkoutUrl: string;
  expiresAt: string;
  installments: number;
  gatewayInstallmentId: string | null;
  charges: GatewayChargeDraft[];
};

export type GetPaymentInput = {
  organizationId: string;
  providerPaymentId: string;
};

export type GatewayPaymentSnapshot = {
  providerPaymentId: string;
  status: InternalPaymentStatus;
  providerStatus: string;
  paidAt: string | null;
  feeAmount: number | null;
  netAmount: number | null;
};

export type CancelPaymentInput = {
  organizationId: string;
  providerPaymentId: string;
  reason?: string;
};

export type RefundPaymentInput = {
  organizationId: string;
  providerPaymentId: string;
  amount?: number;
  reason?: string;
};

export type ParsedWebhookEvent = {
  externalEventId: string;
  eventType: string;
  providerPaymentId: string | null;
  providerStatus: string | null;
  status: InternalPaymentStatus | null;
  occurredAt: string | null;
  rawPayload: unknown;
  /** `account.id` do payload Asaas, se presente. Nao e autenticacao. */
  gatewayAccountId?: string | null;
};

/**
 * Contrato que todo gateway real de pagamento implementa. DTOs de entrada e
 * saida sao sempre internos (organizationId/orderId/paymentId/InternalPaymentStatus)
 * -- nunca objetos ou enums especificos de um gateway espalhados pela aplicacao.
 */
export interface PaymentGatewayProvider {
  readonly name: PaymentProviderName;

  createPixPayment(input: CreatePixPaymentInput): Promise<CreatePixPaymentResult>;

  /**
   * Cria cobranca de cartao SEM dados de cartao. O pagador informa PAN/CVV
   * apenas na pagina hospedada do gateway (`checkoutUrl`).
   */
  createCardPayment(input: CreateCardPaymentInput): Promise<CreateCardPaymentResult>;

  getPayment(input: GetPaymentInput): Promise<GatewayPaymentSnapshot>;

  cancelPayment(input: CancelPaymentInput): Promise<void>;

  refundPayment(input: RefundPaymentInput): Promise<void>;

  /** Verifica autenticidade do webhook (ex: header de token) antes de qualquer parsing de negocio. */
  verifyWebhook(input: { headers: Headers | Record<string, string | string[] | undefined>; rawBody: string }): boolean;

  /** So deve ser chamado apos verifyWebhook(...) === true. */
  parseWebhook(input: { rawBody: string }): ParsedWebhookEvent;
}
