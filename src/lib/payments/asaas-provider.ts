import type {
  CancelPaymentInput,
  CreatePixPaymentInput,
  CreatePixPaymentResult,
  GatewayPaymentSnapshot,
  GetPaymentInput,
  ParsedWebhookEvent,
  PaymentGatewayProvider,
  RefundPaymentInput,
} from "@/lib/payments/provider";
import { mapAsaasPaymentStatus } from "@/lib/payments/asaas-status-map";
import { getHeader } from "@/lib/payments/http-headers";

export type AsaasEnvironment = "sandbox" | "production";

const BASE_URLS: Record<AsaasEnvironment, string> = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3",
};

type AsaasCustomer = { id: string };

type AsaasPayment = {
  id: string;
  status: string;
  value: number;
  netValue: number | null;
  paymentDate: string | null;
  dueDate: string;
};

/**
 * Cliente do gateway Asaas. Skeleton real desta fase: autentica, cria/consulta
 * cliente, cria cobranca PIX, consulta status, cancela e faz parsing/validacao
 * de webhook. NAO esta conectado ao checkout publico ainda -- so e chamado a
 * partir do proprio adapter/testes ate a Fase 2 decidir religar o botao de
 * checkout.
 *
 * Referencias oficiais consultadas nesta implementacao (docs.asaas.com):
 * - Autenticacao: header `access_token` (nao Bearer); sandbox e producao usam
 *   bases e prefixos de chave diferentes.
 * - Cobranca: POST /v3/payments com {customer, billingType: 'PIX', value, dueDate};
 *   QR Code em GET /v3/payments/{id}/pixQrCode.
 * - Webhook: header `asaas-access-token` configurado nas configuracoes do
 *   Webhook; entrega e "at-least-once" (o mesmo evento pode chegar mais de
 *   uma vez) -- deduplicar pelo campo `id` do payload.
 */
export class AsaasPaymentProvider implements PaymentGatewayProvider {
  readonly name = "asaas" as const;

  private readonly apiKey: string;
  private readonly webhookToken: string;
  private readonly baseUrl: string;

  constructor(options: { apiKey: string; webhookToken: string; environment: AsaasEnvironment }) {
    if (!options.apiKey) throw new Error("AsaasPaymentProvider requer ASAAS_API_KEY configurada.");
    if (!options.webhookToken) throw new Error("AsaasPaymentProvider requer ASAAS_WEBHOOK_TOKEN configurada.");
    this.apiKey = options.apiKey;
    this.webhookToken = options.webhookToken;
    this.baseUrl = BASE_URLS[options.environment];
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "militrin-manager",
        access_token: this.apiKey,
        ...(init?.headers ?? {}),
      },
    });

    const text = await response.text();
    const body = text ? (JSON.parse(text) as unknown) : null;

    if (!response.ok) {
      const message =
        body && typeof body === "object" && "errors" in (body as Record<string, unknown>)
          ? JSON.stringify((body as Record<string, unknown>).errors)
          : `HTTP ${response.status}`;
      throw new Error(`Asaas API error (${path}): ${message}`);
    }

    return body as T;
  }

  private async findOrCreateCustomer(payer: CreatePixPaymentInput["payer"], organizationId: string): Promise<string> {
    const cpfCnpj = payer.cpfCnpj.replace(/\D/g, "");

    const existing = await this.request<{ data: AsaasCustomer[] }>(
      `/customers?cpfCnpj=${encodeURIComponent(cpfCnpj)}`
    );
    if (existing.data?.[0]?.id) return existing.data[0].id;

    const created = await this.request<AsaasCustomer>("/customers", {
      method: "POST",
      body: JSON.stringify({
        name: payer.name,
        email: payer.email,
        cpfCnpj,
        phone: payer.phone,
        externalReference: organizationId,
      }),
    });
    return created.id;
  }

  async createPixPayment(input: CreatePixPaymentInput): Promise<CreatePixPaymentResult> {
    const customerId = await this.findOrCreateCustomer(input.payer, input.organizationId);

    const payment = await this.request<AsaasPayment>("/payments", {
      method: "POST",
      body: JSON.stringify({
        customer: customerId,
        billingType: "PIX",
        value: input.amount,
        dueDate: input.dueDate,
        description: input.description,
        externalReference: input.orderId,
      }),
    });

    const qrCode = await this.request<{ encodedImage: string; payload: string; expirationDate: string | null }>(
      `/payments/${payment.id}/pixQrCode`
    );

    return {
      providerPaymentId: payment.id,
      status: mapAsaasPaymentStatus(payment.status),
      pixCode: qrCode.payload,
      pixQrCodeImage: `data:image/png;base64,${qrCode.encodedImage}`,
      expiresAt: qrCode.expirationDate ?? `${input.dueDate}T23:59:59-03:00`,
    };
  }

  async getPayment(input: GetPaymentInput): Promise<GatewayPaymentSnapshot> {
    const payment = await this.request<AsaasPayment>(`/payments/${input.providerPaymentId}`);
    return {
      providerPaymentId: payment.id,
      status: mapAsaasPaymentStatus(payment.status),
      providerStatus: payment.status,
      paidAt: payment.paymentDate,
      feeAmount: payment.netValue != null ? Number((payment.value - payment.netValue).toFixed(2)) : null,
      netAmount: payment.netValue,
    };
  }

  async cancelPayment(input: CancelPaymentInput): Promise<void> {
    void input.reason;
    await this.request(`/payments/${input.providerPaymentId}`, { method: "DELETE" });
  }

  async refundPayment(input: RefundPaymentInput): Promise<void> {
    await this.request(`/payments/${input.providerPaymentId}/refund`, {
      method: "POST",
      body: JSON.stringify({
        value: input.amount,
        description: input.reason,
      }),
    });
  }

  verifyWebhook(input: { headers: Headers | Record<string, string | string[] | undefined>; rawBody: string }): boolean {
    void input.rawBody;
    const token = getHeader(input.headers, "asaas-access-token");
    if (!token) return false;
    return timingSafeEqualString(token, this.webhookToken);
  }

  parseWebhook(input: { rawBody: string }): ParsedWebhookEvent {
    const payload = JSON.parse(input.rawBody) as Record<string, unknown>;
    const payment = (payload.payment ?? {}) as Record<string, unknown>;
    const providerStatus = payment.status ? String(payment.status) : null;

    return {
      externalEventId: String(payload.id ?? ""),
      eventType: String(payload.event ?? ""),
      providerPaymentId: payment.id ? String(payment.id) : null,
      providerStatus,
      status: mapAsaasPaymentStatus(providerStatus),
      occurredAt: payload.dateCreated ? String(payload.dateCreated) : null,
      rawPayload: payload,
    };
  }
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
