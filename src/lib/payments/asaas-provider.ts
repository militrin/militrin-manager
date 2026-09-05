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
} from "./provider.ts";
import { mapAsaasPaymentStatus } from "./asaas-status-map.ts";
import { verifyAsaasWebhookToken } from "./asaas-webhook-token.ts";

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
  invoiceUrl?: string | null;
  installment?: string | null;
  installmentNumber?: number | null;
};

function readAsaasAccountId(payload: Record<string, unknown>): string | null {
  const account = payload.account;
  if (!account || typeof account !== "object") return null;
  const id = (account as Record<string, unknown>).id;
  return id == null || id === "" ? null : String(id);
}

export function parseAsaasWebhookPayload(rawBody: string): ParsedWebhookEvent {
  const payload = JSON.parse(rawBody) as Record<string, unknown>;
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
    gatewayAccountId: readAsaasAccountId(payload),
  };
}

function installmentValue(amount: number, count: number): number {
  return Math.round((amount / count) * 100) / 100;
}

/**
 * Cliente do gateway Asaas usado pelo checkout canonico
 * (`createPixPayment` / `createCardPayment`) e pelo webhook
 * `POST /api/webhooks/asaas`.
 *
 * Cartao: cria CREDIT_CARD SEM objetos creditCard/creditCardHolderInfo e
 * devolve `invoiceUrl` (docs.asaas.com: cobrancas via cartao). PAN/CVV
 * nunca transitam pelo Militrin.
 *
 * Referencias oficiais (docs.asaas.com):
 * - Autenticacao: header `access_token` (nao Bearer); sandbox e producao usam
 *   bases diferentes (`ASAAS_ENVIRONMENT=sandbox|production`).
 * - PIX: POST /v3/payments billingType PIX; QR em GET /v3/payments/{id}/pixQrCode.
 * - Cartao hospedado: POST /v3/payments billingType CREDIT_CARD sem cartao;
 *   redirecionar o pagador para `invoiceUrl`.
 * - Webhook: header `asaas-access-token`; entrega at-least-once.
 */
export class AsaasPaymentProvider implements PaymentGatewayProvider {
  readonly name = "asaas" as const;
  readonly accountKey: string;

  private readonly apiKey: string;
  private readonly webhookToken: string;
  private readonly previousWebhookToken: string | null;
  private readonly baseUrl: string;

  constructor(options: {
    apiKey: string;
    webhookToken: string;
    environment: AsaasEnvironment;
    accountKey: string;
    previousWebhookToken?: string | null;
  }) {
    if (!options.apiKey) throw new Error("AsaasPaymentProvider requer apiKey configurada.");
    if (!options.webhookToken) throw new Error("AsaasPaymentProvider requer webhookToken configurada.");
    if (!options.accountKey.trim()) throw new Error("AsaasPaymentProvider requer accountKey configurada.");
    this.apiKey = options.apiKey;
    this.webhookToken = options.webhookToken;
    this.accountKey = options.accountKey.trim();
    this.previousWebhookToken = options.previousWebhookToken?.trim() || null;
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
      `/customers?cpfCnpj=${encodeURIComponent(cpfCnpj)}`,
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
      `/payments/${payment.id}/pixQrCode`,
    );

    return {
      providerPaymentId: payment.id,
      status: mapAsaasPaymentStatus(payment.status),
      pixCode: qrCode.payload,
      pixQrCodeImage: `data:image/png;base64,${qrCode.encodedImage}`,
      expiresAt: qrCode.expirationDate ?? `${input.dueDate}T23:59:59-03:00`,
    };
  }

  async createCardPayment(input: CreateCardPaymentInput): Promise<CreateCardPaymentResult> {
    const customerId = await this.findOrCreateCustomer(input.payer, input.organizationId);
    const installments = Math.max(1, Math.floor(input.installments ?? 1));

    const body: Record<string, unknown> = {
      customer: customerId,
      billingType: "CREDIT_CARD",
      value: input.amount,
      dueDate: input.dueDate,
      description: input.description,
      externalReference: input.orderId,
    };

    if (installments >= 2) {
      body.installmentCount = installments;
      body.installmentValue = installmentValue(input.amount, installments);
    }

    const successUrl = String(input.successUrl ?? "").trim();
    if (successUrl) {
      body.callback = {
        successUrl,
        autoRedirect: true,
      };
    }

    const payment = await this.request<AsaasPayment>("/payments", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const checkoutUrl = String(payment.invoiceUrl ?? "").trim();
    if (!checkoutUrl) {
      throw new Error("Asaas API error (/payments): invoiceUrl ausente na cobranca de cartao.");
    }

    const installmentId = payment.installment ? String(payment.installment) : null;
    if (installments >= 2 && !installmentId) {
      throw new Error("Asaas API error (/payments): cobranca parcelada sem installment id.");
    }
    const charges = await this.listCardCharges(payment, installmentId, installments, input.amount);

    return {
      providerPaymentId: payment.id,
      status: mapAsaasPaymentStatus(payment.status),
      checkoutUrl,
      expiresAt: `${input.dueDate}T23:59:59-03:00`,
      installments,
      gatewayInstallmentId: installmentId,
      charges,
    };
  }

  private async listCardCharges(
    primary: AsaasPayment,
    installmentId: string | null,
    installments: number,
    totalAmount: number,
  ) {
    if (!installmentId || installments < 2) {
      return [{
        providerPaymentId: primary.id,
        gatewayInstallmentId: installmentId,
        installmentNumber: 1,
        installmentCount: 1,
        amount: Number(primary.value ?? totalAmount),
      }];
    }

    const listed = await this.request<AsaasPayment[] | { data?: AsaasPayment[] }>(
      `/installments/${installmentId}/payments`,
    );
    const rows = Array.isArray(listed)
      ? listed
      : (Array.isArray(listed.data) ? listed.data : []);
    if (rows.length < installments) {
      throw new Error(
        `Asaas API error (/installments/${installmentId}/payments): esperava ${installments} payments do parcelamento, recebeu ${rows.length}.`,
      );
    }

    return rows
      .slice()
      .sort((left, right) => Number(left.installmentNumber ?? 0) - Number(right.installmentNumber ?? 0))
      .map((row) => ({
        providerPaymentId: row.id,
        gatewayInstallmentId: installmentId,
        installmentNumber: Number(row.installmentNumber ?? 1),
        installmentCount: installments,
        amount: Number(row.value ?? 0),
      }));
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
    return verifyAsaasWebhookToken({
      headers: input.headers,
      webhookToken: this.webhookToken,
      previousWebhookToken: this.previousWebhookToken,
    });
  }

  parseWebhook(input: { rawBody: string }): ParsedWebhookEvent {
    return parseAsaasWebhookPayload(input.rawBody);
  }
}
