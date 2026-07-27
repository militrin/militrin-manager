import type { PaymentProvider } from '@/lib/payments/provider';
import { FakePaymentProvider } from '@/lib/payments/fake-provider';
import { MercadoPagoProvider } from '@/lib/payments/mercadopago-provider';

const mockProvider = new FakePaymentProvider();

export function getPaymentProvider(): PaymentProvider {
  const selected = String(process.env.MILITRIN_PAYMENT_PROVIDER ?? 'mock').trim().toLowerCase();

  if (selected === 'mercadopago') {
    const token = String(process.env.MERCADO_PAGO_ACCESS_TOKEN ?? '').trim();
    if (!token) {
      console.warn('MERCADO_PAGO_ACCESS_TOKEN nao definido. Usando MockPaymentProvider.');
      return mockProvider;
    }
    return new MercadoPagoProvider(token);
  }

  return mockProvider;
}
