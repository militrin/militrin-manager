import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginCardCheckoutRedirect,
  cardCheckoutAttemptedStorageKey,
  endCardCheckoutRedirect,
  hasCardCheckoutBeenAttempted,
  markCardCheckoutAttempted,
  resetCardCheckoutRedirectLocksForTests,
  shouldAutoRedirectToHostedCardCheckout,
  shouldOfferCardCheckoutRetry,
  shouldShowCardRedirectingPhase,
} from '../src/lib/checkout/card-checkout-redirect.ts';
import {
  canReuseCardCheckout,
  canContinuePendingCardCheckout,
  isReusableLiveGatewayCharge,
} from '../src/lib/checkout/pix-payment-status.ts';

function memoryStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
  };
}

const future = '2026-09-07T12:00:00.000Z';
const past = '2026-09-06T12:00:00.000Z';
const now = new Date('2026-09-06T18:00:00.000Z');
const liveInvoice = {
  payment_status: 'pending',
  checkout_url: 'https://www.asaas.com/i/pay_live',
  gateway_payment_id: 'pay_live_1',
  expires_at: future,
  gateway_charge_reusable: true,
  now,
};

test.beforeEach(() => {
  resetCardCheckoutRedirectLocksForTests();
});

test('A) novo pedido cartao: primeira tentativa auto-redireciona e mostra fase redirecting', () => {
  assert.equal(shouldAutoRedirectToHostedCardCheckout({
    paymentStatus: 'pending',
    lastGatewayAttemptStatus: null,
    isFakePaymentProvider: false,
    hasOpenedHostedCheckout: false,
    redirectInFlight: false,
  }), true);
  assert.equal(shouldShowCardRedirectingPhase({
    isFakePaymentProvider: false,
    isRedirecting: true,
    hasOpenedHostedCheckout: false,
    paymentStatus: 'pending',
  }), 'redirecting');
  assert.equal(canReuseCardCheckout(liveInvoice), true);
});

test('B) refresh/double start: lock em memoria + cobranca reutilizavel impedem duplicar', () => {
  assert.equal(beginCardCheckoutRedirect('order-1'), true);
  assert.equal(beginCardCheckoutRedirect('order-1'), false);
  assert.equal(beginCardCheckoutRedirect('order-2'), true);
  endCardCheckoutRedirect('order-1');
  assert.equal(beginCardCheckoutRedirect('order-1'), true);

  assert.equal(shouldAutoRedirectToHostedCardCheckout({
    paymentStatus: 'pending',
    isFakePaymentProvider: false,
    hasOpenedHostedCheckout: false,
    redirectInFlight: true,
  }), false);
  assert.equal(isReusableLiveGatewayCharge(liveInvoice), true);
});

test('C) retorno sem pagar: pending_retry, nao auto-redireciona', () => {
  const storage = memoryStorage();
  markCardCheckoutAttempted('order-return', storage);
  assert.equal(hasCardCheckoutBeenAttempted('order-return', storage), true);
  assert.equal(shouldAutoRedirectToHostedCardCheckout({
    paymentStatus: 'pending',
    isFakePaymentProvider: false,
    hasOpenedHostedCheckout: true,
    redirectInFlight: false,
  }), false);
  assert.equal(shouldShowCardRedirectingPhase({
    isFakePaymentProvider: false,
    isRedirecting: false,
    hasOpenedHostedCheckout: true,
    paymentStatus: 'pending',
  }), 'pending_retry');
  assert.equal(shouldOfferCardCheckoutRetry({ paymentStatus: 'pending' }), true);
});

test('D) retry reutiliza invoice valida', () => {
  assert.equal(canReuseCardCheckout(liveInvoice), true);
  assert.equal(isReusableLiveGatewayCharge(liveInvoice), true);
});

test('E) invoice deletada/expirada nao e reutilizada', () => {
  assert.equal(canReuseCardCheckout({
    ...liveInvoice,
    gateway_charge_reusable: false,
  }), false);
  assert.equal(isReusableLiveGatewayCharge({
    ...liveInvoice,
    gateway_charge_reusable: false,
  }), false);
  assert.equal(canReuseCardCheckout({
    ...liveInvoice,
    expires_at: past,
  }), false);
  assert.equal(isReusableLiveGatewayCharge({
    ...liveInvoice,
    expires_at: past,
  }), false);
});

test('F) pagamento confirmado nao redireciona de novo', () => {
  assert.equal(shouldAutoRedirectToHostedCardCheckout({
    paymentStatus: 'paid',
    isFakePaymentProvider: false,
    hasOpenedHostedCheckout: false,
    redirectInFlight: false,
  }), false);
  assert.equal(shouldOfferCardCheckoutRetry({ paymentStatus: 'paid' }), false);
  assert.equal(canReuseCardCheckout({
    ...liveInvoice,
    payment_status: 'paid',
  }), false);
});

test('G) recusa permanece pending com retry, sem auto-redirect', () => {
  assert.equal(shouldAutoRedirectToHostedCardCheckout({
    paymentStatus: 'pending',
    lastGatewayAttemptStatus: 'refused',
    isFakePaymentProvider: false,
    hasOpenedHostedCheckout: false,
    redirectInFlight: false,
  }), false);
  assert.equal(shouldShowCardRedirectingPhase({
    isFakePaymentProvider: false,
    isRedirecting: false,
    hasOpenedHostedCheckout: false,
    paymentStatus: 'pending',
    lastGatewayAttemptStatus: 'refused',
  }), 'pending_retry');
  assert.equal(shouldOfferCardCheckoutRetry({ paymentStatus: 'pending' }), true);
});

test('provider fake nunca auto-redireciona ao checkout hospedado', () => {
  assert.equal(shouldAutoRedirectToHostedCardCheckout({
    paymentStatus: 'pending',
    isFakePaymentProvider: true,
    hasOpenedHostedCheckout: false,
    redirectInFlight: false,
  }), false);
  assert.equal(shouldShowCardRedirectingPhase({
    isFakePaymentProvider: true,
    isRedirecting: true,
    hasOpenedHostedCheckout: false,
    paymentStatus: 'pending',
  }), 'pending_retry');
});

test('auto-redirect falhou cai na fase pending_retry', () => {
  assert.equal(shouldAutoRedirectToHostedCardCheckout({
    paymentStatus: 'pending',
    isFakePaymentProvider: false,
    hasOpenedHostedCheckout: false,
    redirectInFlight: false,
    autoRedirectFailed: true,
  }), false);
  assert.equal(shouldShowCardRedirectingPhase({
    isFakePaymentProvider: false,
    isRedirecting: false,
    hasOpenedHostedCheckout: false,
    autoRedirectFailed: true,
    paymentStatus: 'pending',
  }), 'pending_retry');
});

test('pedido credit_card pendente com reserva vigente pode continuar pagamento', () => {
  assert.equal(canContinuePendingCardCheckout({
    payment_method: 'credit_card',
    payment_status: 'pending',
    expires_at: future,
    now,
  }), true);
  assert.equal(canContinuePendingCardCheckout({
    payment_method: 'credit_card',
    payment_status: 'pending',
    expires_at: null,
    now,
  }), true);
});

test('pedido expirado, pago ou PIX nao abre checkout antigo de cartao', () => {
  assert.equal(canContinuePendingCardCheckout({
    payment_method: 'credit_card',
    payment_status: 'pending',
    expires_at: past,
    now,
  }), false);
  assert.equal(canContinuePendingCardCheckout({
    payment_method: 'credit_card',
    payment_status: 'paid',
    expires_at: future,
    now,
  }), false);
  assert.equal(canContinuePendingCardCheckout({
    payment_method: 'pix',
    payment_status: 'pending',
    expires_at: future,
    now,
  }), false);
  assert.equal(canReuseCardCheckout({
    ...liveInvoice,
    expires_at: past,
  }), false);
});

test('chave de sessao e por pedido', () => {
  assert.equal(
    cardCheckoutAttemptedStorageKey('aa22df94-6886-4cbf-9d56-6a5974af85b2'),
    'militrin:card-checkout-attempted:aa22df94-6886-4cbf-9d56-6a5974af85b2',
  );
  const storage = memoryStorage();
  markCardCheckoutAttempted('order-a', storage);
  assert.equal(hasCardCheckoutBeenAttempted('order-a', storage), true);
  assert.equal(hasCardCheckoutBeenAttempted('order-b', storage), false);
});
