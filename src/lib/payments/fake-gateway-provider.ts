import type {
  CancelPaymentInput,
  CreateCardPaymentInput,
  CreateCardPaymentResult,
  CreatePixPaymentInput,
  CreatePixPaymentResult,
  GatewayPaymentSnapshot,
  GetPaymentInput,
  ParsedWebhookEvent,
  PaymentGatewayProvider,
  RefundPaymentInput,
} from "@/lib/payments/provider";
import { getHeader } from "@/lib/payments/http-headers";

/**
 * Implementacao "fake" do contrato canonico `PaymentGatewayProvider` (nao
 * confundir com `FakePaymentProvider` de src/lib/payments/fake-provider.ts,
 * que implementa o contrato LEGADO participant-centric e continua servindo o
 * fluxo de inscricao antigo). Usada em desenvolvimento/testes para exercitar
 * webhook, idempotencia e confirmacao sem depender de sandbox real da Asaas.
 */
export class FakeGatewayProvider implements PaymentGatewayProvider {
  readonly name = "fake" as const;

  private readonly webhookToken: string | null;

  constructor(options?: { webhookToken?: string | null }) {
    this.webhookToken = options?.webhookToken ?? null;
  }

  async createPixPayment(input: CreatePixPaymentInput): Promise<CreatePixPaymentResult> {
    const providerPaymentId = `fake_${input.orderId}_${Date.now()}`;
    const pixCode = `00020126FAKEPIX${providerPaymentId}5204000053039865406${input.amount.toFixed(2)}5802BR`;
    return {
      providerPaymentId,
      status: "pending",
      pixCode,
      pixQrCodeImage: `data:image/svg+xml;utf8,${encodeURIComponent(
        `<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><rect width='100%' height='100%' fill='#0f172a'/><text x='12' y='120' fill='#10b981' font-size='10' font-family='monospace'>${pixCode.slice(0, 28)}</text></svg>`
      )}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    };
  }

  async createCardPayment(input: CreateCardPaymentInput): Promise<CreateCardPaymentResult> {
    const providerPaymentId = `fake_card_${input.orderId}_${Date.now()}`;
    const installments = Math.max(1, Math.floor(input.installments ?? 1));
    const charges = Array.from({ length: installments }, (_, index) => ({
      providerPaymentId: index === 0 ? providerPaymentId : `${providerPaymentId}_p${index + 1}`,
      gatewayInstallmentId: installments >= 2 ? `inst_${input.orderId}` : null,
      installmentNumber: index + 1,
      installmentCount: installments,
      amount: installments >= 2
        ? Math.round((input.amount / installments) * 100) / 100
        : input.amount,
    }));
    return {
      providerPaymentId,
      status: "pending",
      checkoutUrl: `https://checkout.invalid/asaas/${providerPaymentId}`,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      installments,
      gatewayInstallmentId: installments >= 2 ? `inst_${input.orderId}` : null,
      charges,
    };
  }

  async getPayment(input: GetPaymentInput): Promise<GatewayPaymentSnapshot> {
    return {
      providerPaymentId: input.providerPaymentId,
      status: "pending",
      providerStatus: "PENDING",
      paidAt: null,
      feeAmount: null,
      netAmount: null,
    };
  }

  async cancelPayment(_input: CancelPaymentInput): Promise<void> {
    void _input;
  }

  async refundPayment(_input: RefundPaymentInput): Promise<void> {
    void _input;
  }

  verifyWebhook(input: { headers: Headers | Record<string, string | string[] | undefined>; rawBody: string }): boolean {
    void input.rawBody;
    if (!this.webhookToken) return true;
    const header = getHeader(input.headers, "asaas-access-token");
    return header === this.webhookToken;
  }

  parseWebhook(input: { rawBody: string }): ParsedWebhookEvent {
    const payload = JSON.parse(input.rawBody) as Record<string, unknown>;
    const payment = (payload.payment ?? {}) as Record<string, unknown>;
    return {
      externalEventId: String(payload.id ?? ""),
      eventType: String(payload.event ?? ""),
      providerPaymentId: payment.id ? String(payment.id) : null,
      providerStatus: payment.status ? String(payment.status) : null,
      status: null,
      occurredAt: payload.dateCreated ? String(payload.dateCreated) : null,
      rawPayload: payload,
    };
  }
}
