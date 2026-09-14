import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canContinueCommercialPayment,
  isClosedCommercialPurchase,
  resolveCommercialStatus,
  resolvePaymentDisplayStatus,
} from '../src/lib/dashboard/commercial-status.ts';
import { earlierIsoTimestamp, pixDueDateEndOfDay, resolvePixCommercialExpiresAt } from '../src/lib/payments/pix-due-date.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function accountStatus({ orderStatus, paymentStatus, expiresAt, now }) {
  return resolveCommercialStatus({
    orderStatus,
    paymentStatus,
    reservationExpiresAt: expiresAt,
    now,
  });
}

test('pago confirmado permanece na lista principal e continua pago', () => {
  const status = accountStatus({
    orderStatus: 'pending',
    paymentStatus: 'paid',
    expiresAt: '2026-09-01T12:00:00.000Z',
  });
  assert.equal(status, 'confirmed');
  assert.equal(isClosedCommercialPurchase(status), false);
  assert.equal(canContinueCommercialPayment(status), false);
  assert.equal(resolvePaymentDisplayStatus({ commercialStatus: status, paymentStatus: 'paid' }), 'paid');
});

test('pendente ainda válido aparece na principal com CTA de pagamento', () => {
  const status = accountStatus({
    orderStatus: 'pending',
    paymentStatus: 'pending',
    expiresAt: '2099-01-01T12:00:00.000Z',
  });
  assert.equal(status, 'pending');
  assert.equal(isClosedCommercialPurchase(status), false);
  assert.equal(canContinueCommercialPayment(status), true);
});

test('expires_at passado vira expired na hora, mesmo com payment_status pending', () => {
  const now = new Date('2026-09-12T18:00:00.000Z');
  const status = resolveCommercialStatus({
    orderStatus: 'pending',
    paymentStatus: 'pending',
    reservationExpiresAt: '2026-09-12T17:00:00.000Z',
    now,
  });
  assert.equal(status, 'expired');
  assert.equal(isClosedCommercialPurchase(status), true);
  assert.equal(canContinueCommercialPayment(status), false);
  assert.equal(resolvePaymentDisplayStatus({ commercialStatus: status, paymentStatus: 'pending' }), 'expired');
});

test('expires_at futuro permanece pending', () => {
  const now = new Date('2026-09-12T18:00:00.000Z');
  const status = resolveCommercialStatus({
    orderStatus: 'pending',
    paymentStatus: 'pending',
    reservationExpiresAt: '2026-09-12T19:00:00.000Z',
    now,
  });
  assert.equal(status, 'pending');
});

test('pedido cancelado não mostra pagamento pendente nem CTA', () => {
  const status = accountStatus({
    orderStatus: 'cancelled',
    paymentStatus: 'pending',
    expiresAt: '2099-01-01T12:00:00.000Z',
  });
  assert.equal(status, 'cancelled');
  assert.equal(isClosedCommercialPurchase(status), true);
  assert.equal(canContinueCommercialPayment(status), false);
  assert.equal(resolvePaymentDisplayStatus({ commercialStatus: status, paymentStatus: 'pending' }), 'cancelled');
});

test('cancelado não volta a pending mesmo com expires_at futuro', () => {
  const status = resolveCommercialStatus({
    orderStatus: 'cancelled',
    paymentStatus: 'pending',
    reservationExpiresAt: '2099-01-01T12:00:00.000Z',
  });
  assert.equal(status, 'cancelled');
  assert.notEqual(status, 'pending');
});

test('lista de compras separa encerradas e esconde CTA de pagamento nelas', async () => {
  const source = await read('src/app/minha-conta/compras/page.tsx');
  const closed = await read('src/app/minha-conta/compras/closed-purchases-section.tsx');
  assert.match(source, /ClosedPurchasesSection/);
  assert.match(source, /isClosedCommercialPurchase/);
  assert.match(source, /canContinueCommercialPayment\(commercialStatus\)/);
  assert.match(closed, /Mostrar compras encerradas/);
  assert.match(closed, /Ocultar compras encerradas/);
});

test('detalhe do pedido não oferece Continuar pagamento se comercialmente expirado/cancelado', async () => {
  const source = await read('src/app/minha-conta/compras/[orderId]/page.tsx');
  assert.match(source, /canContinuePayment && paymentMethod === 'pix'/);
  assert.match(source, /isCreditCardPending && canContinueCard/);
  assert.match(source, /A reserva deste pedido expirou/);
});

function ticketOrder({
  id = 'order-1',
  orderStatus = 'pending',
  paymentStatus = 'pending',
  expiresAt = null,
  createdAt = '2026-09-11T23:54:07.893Z',
  paymentMethod = 'pix',
} = {}) {
  return {
    id,
    status: orderStatus,
    payments: [{
      payment_status: paymentStatus,
      expires_at: expiresAt,
      created_at: createdAt,
      payment_method: paymentMethod,
    }],
  };
}

function accountOrderStatus(order, now) {
  const payment = Array.isArray(order.payments) ? order.payments[0] : order.payments;
  return resolveCommercialStatus({
    orderStatus: order.status,
    paymentStatus: payment?.payment_status,
    reservationExpiresAt: resolvePixCommercialExpiresAt({
      expiresAt: payment?.expires_at,
      paymentCreatedAt: payment?.created_at,
      paymentMethod: payment?.payment_method,
    }),
    now,
  });
}

function findActionableAccountOrder(orders, now) {
  return orders.find((order) => canContinueCommercialPayment(accountOrderStatus(order, now))) ?? null;
}

test('PIX com expires_at futuro no mesmo dia continua acionavel na Home e em compras', () => {
  const now = new Date('2026-09-11T21:00:00.000Z');
  const order = ticketOrder({ expiresAt: '2026-09-12T02:59:59.000Z' });
  const status = accountOrderStatus(order, now);
  assert.equal(status, 'pending');
  assert.equal(canContinueCommercialPayment(status), true);
  assert.equal(findActionableAccountOrder([order], now)?.id, 'order-1');
});

test('PIX com expirationDate Asaas de ~1 ano nao permanece pendente depois do vencimento do dia', () => {
  const now = new Date('2026-09-14T00:00:00.000Z');
  const order = ticketOrder({
    expiresAt: '2027-09-11T23:59:59.000Z',
    createdAt: '2026-09-11T23:54:07.893Z',
  });
  const status = accountOrderStatus(order, now);
  assert.equal(status, 'expired');
  assert.equal(canContinueCommercialPayment(status), false);
  assert.equal(findActionableAccountOrder([order], now), null);
  assert.equal(
    resolvePixCommercialExpiresAt({
      expiresAt: '2027-09-11T23:59:59.000Z',
      paymentCreatedAt: '2026-09-11T23:54:07.893Z',
      paymentMethod: 'pix',
    }),
    pixDueDateEndOfDay('2026-09-11'),
  );
});

test('dueDate explicito e a fonte primaria, nao a heuristica de 30 dias', () => {
  assert.equal(
    resolvePixCommercialExpiresAt({
      expiresAt: '2027-09-11T23:59:59.000Z',
      paymentCreatedAt: '2026-09-01T10:00:00.000Z',
      paymentMethod: 'pix',
      dueDate: '2026-09-11',
    }),
    pixDueDateEndOfDay('2026-09-11'),
  );
});

test('PIX sem dueDate e sem artefato de QR confia no expires_at persistido', () => {
  assert.equal(
    resolvePixCommercialExpiresAt({
      expiresAt: '2026-09-11T23:59:59-03:00',
      paymentCreatedAt: '2026-09-11T23:54:07.893Z',
      paymentMethod: 'pix',
    }),
    '2026-09-11T23:59:59-03:00',
  );
});

test('PIX sem created_at e sem dueDate devolve o expires_at persistido', () => {
  assert.equal(
    resolvePixCommercialExpiresAt({
      expiresAt: '2027-09-11T23:59:59.000Z',
      paymentCreatedAt: null,
      paymentMethod: 'pix',
    }),
    '2027-09-11T23:59:59.000Z',
  );
});

test('cartao nunca aplica fallback de artefato de QR PIX', () => {
  assert.equal(
    resolvePixCommercialExpiresAt({
      expiresAt: '2027-09-11T23:59:59.000Z',
      paymentCreatedAt: '2026-09-11T23:54:07.893Z',
      paymentMethod: 'credit_card',
    }),
    '2027-09-11T23:59:59.000Z',
  );
});

test('cobranca paga nunca e classificada como expirada pelo prazo', () => {
  const now = new Date('2026-09-14T00:00:00.000Z');
  const order = ticketOrder({
    paymentStatus: 'paid',
    expiresAt: '2026-09-11T23:59:59.000Z',
  });
  assert.equal(accountOrderStatus(order, now), 'confirmed');
  assert.equal(findActionableAccountOrder([order], now), null);
});

test('pedido 1653 nao e acionavel na Home nem em Compras apos o dueDate', () => {
  const now = new Date('2026-09-13T15:00:00.000Z');
  const order = ticketOrder({
    id: '3cc5376f-98ed-4c48-8d9b-a2f4fe210760',
    expiresAt: '2027-09-11T23:59:59.000Z',
    createdAt: '2026-09-11T23:54:07.893Z',
  });
  assert.equal(accountOrderStatus(order, now), 'expired');
  assert.equal(findActionableAccountOrder([order], now), null);
});

test('expires_at passado nao aparece como compra acionavel', () => {
  const now = new Date('2026-09-12T18:00:00.000Z');
  const order = ticketOrder({
    paymentMethod: 'credit_card',
    expiresAt: '2026-09-12T17:00:00.000Z',
  });
  const status = accountOrderStatus(order, now);
  assert.equal(status, 'expired');
  assert.equal(findActionableAccountOrder([order], now), null);
});

test('cancelado, pago e estornado nao aparecem como compra acionavel', () => {
  const now = new Date('2026-09-12T18:00:00.000Z');
  const future = '2099-01-01T12:00:00.000Z';
  assert.equal(findActionableAccountOrder([ticketOrder({ orderStatus: 'cancelled', expiresAt: future })], now), null);
  assert.equal(findActionableAccountOrder([ticketOrder({ paymentStatus: 'paid', expiresAt: future })], now), null);
  assert.equal(findActionableAccountOrder([ticketOrder({ paymentStatus: 'refunded', expiresAt: future })], now), null);
});

test('canContinueCommercialPayment=false nunca e selecionado pela Home', () => {
  const now = new Date('2026-09-12T18:00:00.000Z');
  const expired = ticketOrder({ id: 'expired', paymentStatus: 'expired', expiresAt: null, paymentMethod: 'credit_card' });
  const pending = ticketOrder({ id: 'live', expiresAt: '2026-09-12T19:00:00.000Z', createdAt: '2026-09-12T10:00:00.000Z' });
  assert.equal(findActionableAccountOrder([expired, pending], now)?.id, 'live');
  assert.equal(findActionableAccountOrder([expired], now), null);
});

test('Home e compras reusam a mesma selecao canonica de pedido acionavel', async () => {
  const page = await read('src/app/minha-conta/page.tsx');
  const portal = await read('src/lib/account/portal-orders-and-tickets.ts');
  assert.match(page, /findActionableAccountOrder\(orders\)/);
  assert.match(portal, /resolvePixCommercialExpiresAt/);
  assert.match(portal, /canContinueCommercialPayment\(resolveAccountOrderStatus\(order, now\)\)/);
  assert.match(portal, /expires_at, created_at/);
});

test('PIX persistido usa o vencimento comercial do dueDate, nao o QR de 1 ano', async () => {
  assert.equal(
    earlierIsoTimestamp('2027-09-11T23:59:59.000Z', pixDueDateEndOfDay('2026-09-11')),
    pixDueDateEndOfDay('2026-09-11'),
  );
  const asaas = await read('src/lib/payments/asaas-provider.ts');
  assert.match(asaas, /earlierIsoTimestamp\(qrCode\.expirationDate, pixDueDateEndOfDay\(input\.dueDate\)\)/);
});

