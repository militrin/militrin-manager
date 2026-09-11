import test from 'node:test';
import assert from 'node:assert/strict';
import { AsaasPaymentProvider, parseAsaasWebhookPayload } from '../src/lib/payments/asaas-provider.ts';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

function provider() {
  return new AsaasPaymentProvider({
    apiKey: 'test-key',
    webhookToken: 'wh',
    environment: 'sandbox',
    accountKey: 'conta-card',
  });
}

const cardInput = {
  organizationId: 'org',
  orderId: 'order-1',
  paymentId: 'pay-local',
  amount: 150,
  dueDate: '2026-09-04',
  installments: 1,
  successUrl: 'http://localhost:3000/pagamento/retorno?pedido=order-1',
  payer: { name: 'Ana', email: 'ana@example.com', cpfCnpj: '52998224725' },
};

function mockFetch(handler) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const request = { href, method: init?.method ?? 'GET', body };
    requests.push(request);
    return handler(request);
  };
  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test('createCardPayment nao envia PAN/CVV, usa invoiceUrl e envia callback de retorno', async () => {
  const { requests, restore } = mockFetch(({ href, method }) => {
    if (href.includes('/customers?')) return json({ data: [{ id: 'cus_1' }] });
    if (href.includes('/payments?externalReference=')) return json({ data: [] });
    if (href.endsWith('/payments') && method === 'POST') {
      return json({
        id: 'pay_card_1',
        status: 'PENDING',
        value: 150,
        netValue: null,
        paymentDate: null,
        dueDate: '2026-09-04',
        billingType: 'CREDIT_CARD',
        invoiceUrl: 'https://sandbox.asaas.com/i/pay_card_1',
      });
    }
    throw new Error(`fetch inesperado: ${href}`);
  });

  try {
    const result = await provider().createCardPayment(cardInput);

    const create = requests.find((request) => request.href.endsWith('/payments') && request.method === 'POST');
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
    restore();
  }
});

test('createCardPayment 2x persiste installment e todos os pay_ da lista Asaas', async () => {
  const { requests, restore } = mockFetch(({ href, method }) => {
    if (href.includes('/customers?')) return json({ data: [{ id: 'cus_1' }] });
    if (href.includes('/payments?externalReference=')) return json({ data: [] });
    if (href.endsWith('/payments') && method === 'POST') {
      return json({
        id: 'pay_p1',
        status: 'PENDING',
        value: 40,
        billingType: 'CREDIT_CARD',
        installment: 'inst_9',
        installmentNumber: 1,
        invoiceUrl: 'https://sandbox.asaas.com/i/pay_p1',
      });
    }
    if (href.includes('/installments/inst_9/payments')) {
      return json({
        data: [
          { id: 'pay_p1', status: 'PENDING', value: 40, installmentNumber: 1 },
          { id: 'pay_p2', status: 'PENDING', value: 40, installmentNumber: 2 },
        ],
      });
    }
    throw new Error(`fetch inesperado: ${href}`);
  });

  try {
    const result = await provider().createCardPayment({
      ...cardInput,
      orderId: 'order-2x',
      amount: 80,
      installments: 2,
      successUrl: 'http://localhost:3000/pagamento/retorno?pedido=order-2x',
    });

    const create = requests.find((request) => request.href.endsWith('/payments') && request.method === 'POST');
    assert.equal(create.body.installmentCount, 2);
    assert.equal(create.body.callback.autoRedirect, true);
    assert.equal(result.gatewayInstallmentId, 'inst_9');
    assert.equal(result.charges.length, 2);
    assert.deepEqual(result.charges.map((charge) => charge.providerPaymentId), ['pay_p1', 'pay_p2']);
  } finally {
    restore();
  }
});

test('POST sem invoiceUrl hidrata a URL via GET /payments/{id} e nao trata como falha', async () => {
  const { requests, restore } = mockFetch(({ href, method }) => {
    if (href.includes('/customers?')) return json({ data: [{ id: 'cus_1' }] });
    if (href.includes('/payments?externalReference=')) return json({ data: [] });
    if (href.endsWith('/payments') && method === 'POST') {
      return json({
        id: 'pay_no_url',
        status: 'PENDING',
        value: 150,
        billingType: 'CREDIT_CARD',
        invoiceUrl: null,
      });
    }
    if (href.endsWith('/payments/pay_no_url') && method === 'GET') {
      return json({
        id: 'pay_no_url',
        status: 'PENDING',
        value: 150,
        billingType: 'CREDIT_CARD',
        invoiceUrl: 'https://sandbox.asaas.com/i/pay_no_url',
      });
    }
    throw new Error(`fetch inesperado: ${href}`);
  });

  try {
    const result = await provider().createCardPayment(cardInput);
    assert.equal(result.providerPaymentId, 'pay_no_url');
    assert.equal(result.checkoutUrl, 'https://sandbox.asaas.com/i/pay_no_url');
    assert.equal(requests.filter((request) => request.method === 'POST' && request.href.endsWith('/payments')).length, 1);
  } finally {
    restore();
  }
});

test('POST com timeout recupera a cobranca CREDIT_CARD ja criada pelo externalReference', async () => {
  let posted = false;
  const { requests, restore } = mockFetch(({ href, method }) => {
    if (href.includes('/customers?')) return json({ data: [{ id: 'cus_1' }] });
    if (href.includes('/payments?externalReference=')) {
      return json({
        data: posted
          ? [{
              id: 'pay_recovered',
              status: 'PENDING',
              value: 150,
              billingType: 'CREDIT_CARD',
              invoiceUrl: 'https://sandbox.asaas.com/i/pay_recovered',
            }]
          : [],
      });
    }
    if (href.endsWith('/payments') && method === 'POST') {
      posted = true;
      throw new Error('Timeout ao chamar Asaas (/payments).');
    }
    throw new Error(`fetch inesperado: ${href}`);
  });

  try {
    const result = await provider().createCardPayment(cardInput);
    assert.equal(result.providerPaymentId, 'pay_recovered');
    assert.equal(result.checkoutUrl, 'https://sandbox.asaas.com/i/pay_recovered');
    assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  } finally {
    restore();
  }
});

test('cobranca CREDIT_CARD aberta para o mesmo orderId nao gera segundo POST', async () => {
  const { requests, restore } = mockFetch(({ href, method }) => {
    if (href.includes('/customers?')) return json({ data: [{ id: 'cus_1' }] });
    if (href.includes('/payments?externalReference=')) {
      return json({
        data: [
          { id: 'pay_pix', status: 'PENDING', billingType: 'PIX', invoiceUrl: null },
          {
            id: 'pay_existing_card',
            status: 'PENDING',
            value: 150,
            billingType: 'CREDIT_CARD',
            invoiceUrl: 'https://sandbox.asaas.com/i/pay_existing_card',
          },
        ],
      });
    }
    if (href.endsWith('/payments') && method === 'POST') {
      throw new Error('nao deveria criar nova cobranca');
    }
    throw new Error(`fetch inesperado: ${href}`);
  });

  try {
    const result = await provider().createCardPayment(cardInput);
    assert.equal(result.providerPaymentId, 'pay_existing_card');
    assert.equal(result.checkoutUrl, 'https://sandbox.asaas.com/i/pay_existing_card');
    assert.equal(requests.filter((request) => request.method === 'POST').length, 0);
    assert.ok(requests.some((request) => request.href.includes(`externalReference=${encodeURIComponent(cardInput.orderId)}`)));
  } finally {
    restore();
  }
});

test('reuso por externalReference ignora paga, cancelada, expirada, outro metodo e outro pedido', async () => {
  const cases = [
    {
      name: 'paga RECEIVED',
      listed: [{ id: 'pay_paid', status: 'RECEIVED', billingType: 'CREDIT_CARD', invoiceUrl: 'https://sandbox.asaas.com/i/pay_paid' }],
    },
    {
      name: 'paga CONFIRMED',
      listed: [{ id: 'pay_confirmed', status: 'CONFIRMED', billingType: 'CREDIT_CARD', invoiceUrl: 'https://sandbox.asaas.com/i/pay_confirmed' }],
    },
    {
      name: 'expirada OVERDUE',
      listed: [{ id: 'pay_overdue', status: 'OVERDUE', billingType: 'CREDIT_CARD', invoiceUrl: 'https://sandbox.asaas.com/i/pay_overdue' }],
    },
    {
      name: 'estornada REFUNDED',
      listed: [{ id: 'pay_refunded', status: 'REFUNDED', billingType: 'CREDIT_CARD', invoiceUrl: 'https://sandbox.asaas.com/i/pay_refunded' }],
    },
    {
      name: 'apenas PIX',
      listed: [{ id: 'pay_pix_only', status: 'PENDING', billingType: 'PIX', invoiceUrl: null }],
    },
  ];

  for (const scenario of cases) {
    const { requests, restore } = mockFetch(({ href, method }) => {
      if (href.includes('/customers?')) return json({ data: [{ id: 'cus_1' }] });
      if (href.includes('/payments?externalReference=')) return json({ data: scenario.listed });
      if (href.endsWith('/payments') && method === 'POST') {
        return json({
          id: 'pay_new_card',
          status: 'PENDING',
          value: 150,
          billingType: 'CREDIT_CARD',
          invoiceUrl: 'https://sandbox.asaas.com/i/pay_new_card',
        });
      }
      throw new Error(`fetch inesperado (${scenario.name}): ${href}`);
    });

    try {
      const result = await provider().createCardPayment(cardInput);
      assert.equal(result.providerPaymentId, 'pay_new_card', scenario.name);
      assert.equal(requests.filter((request) => request.method === 'POST').length, 1, scenario.name);
      assert.ok(
        requests.some((request) => request.href.includes(`externalReference=${encodeURIComponent(cardInput.orderId)}`)),
        scenario.name,
      );
    } finally {
      restore();
    }
  }
});

test('consulta de reuso usa o orderId informado e nao mistura outro pedido', async () => {
  const { requests, restore } = mockFetch(({ href, method }) => {
    if (href.includes('/customers?')) return json({ data: [{ id: 'cus_1' }] });
    if (href.includes('/payments?externalReference=')) {
      assert.ok(href.includes(`externalReference=${encodeURIComponent('order-1')}`));
      assert.equal(href.includes('order-other'), false);
      if (href.includes(`externalReference=${encodeURIComponent('order-other')}`)) {
        return json({
          data: [{
            id: 'pay_other_order',
            status: 'PENDING',
            billingType: 'CREDIT_CARD',
            invoiceUrl: 'https://sandbox.asaas.com/i/pay_other_order',
          }],
        });
      }
      return json({ data: [] });
    }
    if (href.endsWith('/payments') && method === 'POST') {
      return json({
        id: 'pay_this_order',
        status: 'PENDING',
        billingType: 'CREDIT_CARD',
        invoiceUrl: 'https://sandbox.asaas.com/i/pay_this_order',
      });
    }
    throw new Error(`fetch inesperado: ${href}`);
  });

  try {
    const result = await provider().createCardPayment(cardInput);
    assert.equal(result.providerPaymentId, 'pay_this_order');
    assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
  } finally {
    restore();
  }
});

test('getPayment le so o id informado e devolve status/URL sem buscar por externalReference', async () => {
  const { requests, restore } = mockFetch(({ href }) => {
    if (href.endsWith('/payments/pay_get')) {
      return json({
        id: 'pay_get',
        status: 'PENDING',
        value: 150,
        netValue: 145.5,
        paymentDate: null,
        invoiceUrl: 'https://sandbox.asaas.com/i/pay_get',
      });
    }
    throw new Error(`fetch inesperado: ${href}`);
  });

  try {
    const snapshot = await provider().getPayment({ organizationId: 'org', providerPaymentId: 'pay_get' });
    assert.equal(snapshot.providerPaymentId, 'pay_get');
    assert.equal(snapshot.checkoutUrl, 'https://sandbox.asaas.com/i/pay_get');
    assert.equal(snapshot.status, 'pending');
    assert.equal(requests.some((request) => request.href.includes('externalReference=')), false);
  } finally {
    restore();
  }
});

test('getPayment de cobranca paga/expirada nao e selecionada pelo reuso de createCardPayment', async () => {
  const snapshotPaid = await (async () => {
    const { restore } = mockFetch(({ href }) => {
      if (href.endsWith('/payments/pay_paid')) {
        return json({
          id: 'pay_paid',
          status: 'RECEIVED',
          value: 150,
          netValue: 145.5,
          paymentDate: '2026-09-11',
          invoiceUrl: 'https://sandbox.asaas.com/i/pay_paid',
        });
      }
      throw new Error(`fetch inesperado: ${href}`);
    });
    try {
      return await provider().getPayment({ organizationId: 'org', providerPaymentId: 'pay_paid' });
    } finally {
      restore();
    }
  })();
  assert.equal(snapshotPaid.status, 'paid');

  const snapshotExpired = await (async () => {
    const { restore } = mockFetch(({ href }) => {
      if (href.endsWith('/payments/pay_overdue')) {
        return json({
          id: 'pay_overdue',
          status: 'OVERDUE',
          value: 150,
          netValue: null,
          paymentDate: null,
          invoiceUrl: 'https://sandbox.asaas.com/i/pay_overdue',
        });
      }
      throw new Error(`fetch inesperado: ${href}`);
    });
    try {
      return await provider().getPayment({ organizationId: 'org', providerPaymentId: 'pay_overdue' });
    } finally {
      restore();
    }
  })();
  assert.equal(snapshotExpired.status, 'expired');
});

test('falha em listCardCharges ainda devolve a cobranca primaria com URL', async () => {
  const { restore } = mockFetch(({ href, method }) => {
    if (href.includes('/customers?')) return json({ data: [{ id: 'cus_1' }] });
    if (href.includes('/payments?externalReference=')) return json({ data: [] });
    if (href.endsWith('/payments') && method === 'POST') {
      return json({
        id: 'pay_p1',
        status: 'PENDING',
        value: 40,
        billingType: 'CREDIT_CARD',
        installment: 'inst_fail',
        invoiceUrl: 'https://sandbox.asaas.com/i/pay_p1',
      });
    }
    if (href.includes('/installments/inst_fail/payments')) {
      return json({ errors: [{ description: 'unavailable' }] }, 500);
    }
    throw new Error(`fetch inesperado: ${href}`);
  });

  try {
    const result = await provider().createCardPayment({
      ...cardInput,
      orderId: 'order-2x-fail',
      amount: 80,
      installments: 2,
    });
    assert.equal(result.providerPaymentId, 'pay_p1');
    assert.equal(result.checkoutUrl, 'https://sandbox.asaas.com/i/pay_p1');
    assert.equal(result.charges.length, 1);
    assert.equal(result.charges[0].providerPaymentId, 'pay_p1');
  } finally {
    restore();
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
