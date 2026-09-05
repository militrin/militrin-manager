import test from 'node:test';
import assert from 'node:assert/strict';
import { AsaasPaymentProvider, parseAsaasWebhookPayload } from '../src/lib/payments/asaas-provider.ts';

test('createCardPayment nao envia PAN/CVV, usa invoiceUrl e envia callback de retorno', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ href, method: init?.method ?? 'GET', body });
    if (href.includes('/customers?')) {
      return new Response(JSON.stringify({ data: [{ id: 'cus_1' }] }), { status: 200 });
    }
    if (href.endsWith('/payments') && init?.method === 'POST') {
      return new Response(JSON.stringify({
        id: 'pay_card_1',
        status: 'PENDING',
        value: 150,
        netValue: null,
        paymentDate: null,
        dueDate: '2026-09-04',
        invoiceUrl: 'https://sandbox.asaas.com/i/pay_card_1',
      }), { status: 200 });
    }
    throw new Error(`fetch inesperado: ${href}`);
  };

  try {
    const provider = new AsaasPaymentProvider({
      apiKey: 'test-key',
      webhookToken: 'wh',
      environment: 'sandbox',
      accountKey: 'conta-card',
    });
    const result = await provider.createCardPayment({
      organizationId: 'org',
      orderId: 'order-1',
      paymentId: 'pay-local',
      amount: 150,
      dueDate: '2026-09-04',
      installments: 1,
      successUrl: 'http://localhost:3000/pagamento/retorno?pedido=order-1',
      payer: { name: 'Ana', email: 'ana@example.com', cpfCnpj: '52998224725' },
    });

    const create = requests.find((request) => request.href.endsWith('/payments'));
    assert.ok(create);
    assert.equal(create.body.billingType, 'CREDIT_CARD');
    assert.equal(create.body.creditCard, undefined);
    assert.equal(create.body.creditCardHolderInfo, undefined);
    assert.equal(create.body.creditCardToken, undefined);
    assert.equal(create.body.installmentCount, undefined);
    assert.deepEqual(create.body.callback, {
      successUrl: 'http://localhost:3000/pagamento/retorno?pedido=order-1',
      autoRedirect: true,
    });
    assert.equal(result.checkoutUrl, 'https://sandbox.asaas.com/i/pay_card_1');
    assert.equal(result.providerPaymentId, 'pay_card_1');
    assert.equal(result.charges.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createCardPayment 2x persiste installment e todos os pay_ da lista Asaas', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ href, method: init?.method ?? 'GET', body });
    if (href.includes('/customers?')) {
      return new Response(JSON.stringify({ data: [{ id: 'cus_1' }] }), { status: 200 });
    }
    if (href.endsWith('/payments') && init?.method === 'POST') {
      return new Response(JSON.stringify({
        id: 'pay_p1',
        status: 'PENDING',
        value: 40,
        installment: 'inst_9',
        installmentNumber: 1,
        invoiceUrl: 'https://sandbox.asaas.com/i/pay_p1',
      }), { status: 200 });
    }
    if (href.includes('/installments/inst_9/payments')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'pay_p1', status: 'PENDING', value: 40, installmentNumber: 1 },
          { id: 'pay_p2', status: 'PENDING', value: 40, installmentNumber: 2 },
        ],
      }), { status: 200 });
    }
    throw new Error(`fetch inesperado: ${href}`);
  };

  try {
    const provider = new AsaasPaymentProvider({
      apiKey: 'test-key',
      webhookToken: 'wh',
      environment: 'sandbox',
      accountKey: 'conta-card',
    });
    const result = await provider.createCardPayment({
      organizationId: 'org',
      orderId: 'order-2x',
      paymentId: 'pay-local',
      amount: 80,
      dueDate: '2026-09-04',
      installments: 2,
      successUrl: 'http://localhost:3000/pagamento/retorno?pedido=order-2x',
      payer: { name: 'Ana', email: 'ana@example.com', cpfCnpj: '52998224725' },
    });

    const create = requests.find((request) => request.href.endsWith('/payments'));
    assert.equal(create.body.installmentCount, 2);
    assert.equal(create.body.callback.autoRedirect, true);
    assert.equal(result.gatewayInstallmentId, 'inst_9');
    assert.equal(result.charges.length, 2);
    assert.deepEqual(result.charges.map((charge) => charge.providerPaymentId), ['pay_p1', 'pay_p2']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('webhook CAPTURE_REFUSED e reconhecido pelo tipo do evento, mesmo com payment.status PENDING', () => {
  const parsed = parseAsaasWebhookPayload(JSON.stringify({
    id: 'evt_refused',
    event: 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED',
    payment: { id: 'pay_1', status: 'PENDING' },
  }));
  assert.equal(parsed.eventType, 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED');
  assert.equal(parsed.status, 'pending');
  assert.equal(parsed.providerPaymentId, 'pay_1');
});
