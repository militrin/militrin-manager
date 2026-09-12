import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canContinuePendingCardCheckout,
  canReuseCardCheckout,
} from '../src/lib/checkout/pix-payment-status.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  orderPage,
  continueButton,
  pixWatcher,
  pixAction,
  cardAction,
] = await Promise.all([
  read('src/app/minha-conta/compras/[orderId]/page.tsx'),
  read('src/app/minha-conta/compras/[orderId]/continue-card-payment-button.tsx'),
  read('src/app/minha-conta/compras/[orderId]/pending-pix-payment-watcher.tsx'),
  read('src/app/inscricao/actions.ts'),
  read('src/lib/payments/asaas-provider.ts'),
]);

const pixContinue = orderPage.slice(
  orderPage.indexOf('async function continuePaymentAction()'),
  orderPage.indexOf('return (', orderPage.indexOf('async function continuePaymentAction()')),
);

test('Continuar pagamento de cartao usa generatePublicOrderCardAction, nao PIX', () => {
  assert.match(continueButton, /generatePublicOrderCardAction\(orderId\)/);
  assert.match(continueButton, /window\.location\.assign\(checkoutUrl\)/);
  assert.match(orderPage, /ContinueCardPaymentButton/);
  assert.match(orderPage, /canContinuePendingCardCheckout/);
  assert.match(pixContinue, /generatePublicOrderPixAction\(orderId\)/);
  assert.doesNotMatch(pixContinue, /generatePublicOrderCardAction/);
  assert.match(orderPage, /paymentMethod === 'pix'/);
  assert.match(orderPage, /isCreditCardPending && canContinueCard/);
});

test('continuar com URL existente redireciona para checkout_url da action', () => {
  assert.match(continueButton, /const checkoutUrl = String\(result\.payment\?\.checkout_url \?\? ''\)\.trim\(\)/);
  assert.match(continueButton, /window\.location\.assign\(checkoutUrl\)/);
  assert.match(orderPage, /checkout_url: string \| null/);
});

test('continuar com gateway_payment_id sem URL hidrata via a mesma action do wizard', () => {
  assert.match(orderPage, /gateway_payment_id: string \| null/);
  assert.match(pixAction, /withHydratedCardCheckoutUrl/);
  assert.match(continueButton, /generatePublicOrderCardAction\(orderId\)/);
});

test('ausencia de cobranca local ainda chama a action idempotente, que recupera por externalReference', () => {
  assert.match(cardAction, /findOpenCardPaymentByOrderId\(input\.orderId\)/);
  assert.match(continueButton, /generatePublicOrderCardAction\(orderId\)/);
  assert.match(continueButton, /beginCardCheckoutRedirect\(orderId\)/);
});

test('duas tentativas nao duplicam: lock local + action de reuso', () => {
  assert.match(continueButton, /if \(!beginCardCheckoutRedirect\(orderId\)\) return/);
  assert.match(cardAction, /findOpenCardPaymentByOrderId\(input\.orderId\)/);
});

test('pedido expirado nao mostra Continuar pagamento de cartao nem reusa invoice morta', () => {
  assert.match(orderPage, /A reserva deste pedido expirou/);
  assert.match(orderPage, /isCreditCardPending && canContinueCard/);
  const now = new Date('2026-09-11T20:00:00.000Z');
  assert.equal(canContinuePendingCardCheckout({
    payment_method: 'credit_card',
    payment_status: 'pending',
    expires_at: '2026-09-11T19:00:00.000Z',
    now,
  }), false);
  assert.equal(canReuseCardCheckout({
    payment_status: 'pending',
    checkout_url: 'https://www.asaas.com/i/old',
    expires_at: '2026-09-11T19:00:00.000Z',
    gateway_charge_reusable: true,
    now,
  }), false);
});

test('erro real mostra mensagem; loading enquanto recupera', () => {
  assert.match(continueButton, /Preparando pagamento/);
  assert.match(continueButton, /Nao foi possivel continuar o pagamento com cartao/);
  assert.match(continueButton, /loading=\{isPending\}/);
});

test('PIX da ficha do pedido permanece no proprio caminho', () => {
  assert.match(pixWatcher, /PendingPixPaymentWatcher/);
  assert.match(orderPage, /generatePublicOrderPixAction\(orderId\)/);
  assert.match(orderPage, /PixCodeBox code=\{String\(order\.payment\.pix_code\)\}/);
  assert.doesNotMatch(continueButton, /generatePublicOrderPixAction/);
});
