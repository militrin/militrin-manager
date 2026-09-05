import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePaymentGatewayEventPayload } from '../src/lib/payments/sanitize-gateway-event-payload.ts';

test('persistencia minima do webhook: id, evento, status e valor -- sem PII nem PIX', () => {
  const sanitized = sanitizePaymentGatewayEventPayload({
    id: 'evt_1',
    event: 'PAYMENT_RECEIVED',
    dateCreated: '2026-09-03',
    account: { id: 'acc_123', name: 'Nao persistir nome' },
    payment: {
      id: 'pay_1',
      status: 'RECEIVED',
      value: 150,
      netValue: 145.2,
      customer: 'cus_secret',
      pixQrCode: 'copia-e-cola-secreto',
      billingType: 'PIX',
      externalReference: 'order-uuid',
    },
    customer: { cpfCnpj: '52998224725', email: 'pessoa@example.com', name: 'Pessoa' },
  });

  assert.equal(sanitized.id, 'evt_1');
  assert.equal(sanitized.event, 'PAYMENT_RECEIVED');
  assert.deepEqual(sanitized.account, { id: 'acc_123' });
  assert.deepEqual(sanitized.payment, {
    id: 'pay_1',
    status: 'RECEIVED',
    value: 150,
    netValue: 145.2,
    paymentDate: null,
    dueDate: null,
    billingType: 'PIX',
    externalReference: 'order-uuid',
  });
  assert.equal(JSON.stringify(sanitized).includes('52998224725'), false);
  assert.equal(JSON.stringify(sanitized).includes('pessoa@example.com'), false);
  assert.equal(JSON.stringify(sanitized).includes('copia-e-cola-secreto'), false);
  assert.equal(JSON.stringify(sanitized).includes('cus_secret'), false);
  assert.equal(JSON.stringify(sanitized).includes('Nao persistir nome'), false);
});
