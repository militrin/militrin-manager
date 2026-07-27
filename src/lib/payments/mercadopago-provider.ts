import type { PaymentMethod, PaymentProvider, PixPayload } from '@/lib/payments/provider';

export class MercadoPagoProvider implements PaymentProvider {
  private readonly accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken;
  }

  private assertConfigured() {
    if (!this.accessToken) {
      throw new Error('MercadoPagoProvider nao configurado. Defina MERCADO_PAGO_ACCESS_TOKEN.');
    }
  }

  async createPix(input: { participantId: string; amount: number; expiresInMinutes: number }): Promise<PixPayload> {
    this.assertConfigured();
    void input;
    throw new Error('MercadoPagoProvider.createPix ainda nao implementado.');
  }

  async confirmPayment(input: { participantId: string; method: PaymentMethod }): Promise<{ confirmedAt: string }> {
    this.assertConfigured();
    void input;
    throw new Error('MercadoPagoProvider.confirmPayment ainda nao implementado.');
  }

  async cancelPayment(input: { participantId: string; reason?: string }): Promise<{ cancelledAt: string }> {
    this.assertConfigured();
    void input;
    throw new Error('MercadoPagoProvider.cancelPayment ainda nao implementado.');
  }

  async refund(input: { participantId: string; reason?: string }): Promise<{ refundedAt: string }> {
    this.assertConfigured();
    void input;
    throw new Error('MercadoPagoProvider.refund ainda nao implementado.');
  }
}
