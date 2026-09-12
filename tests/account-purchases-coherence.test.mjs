import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canContinueCommercialPayment,
  isClosedCommercialPurchase,
  resolveCommercialStatus,
  resolvePaymentDisplayStatus,
} from '../src/lib/dashboard/commercial-status.ts';

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
