import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  actions,
  wizard,
  cardCard,
  returnClient,
  webhook,
  provider,
  pixStatus,
] = await Promise.all([
  read('src/app/inscricao/actions.ts'),
  read('src/app/inscricao/[eventSlug]/wizard.tsx'),
  read('src/app/inscricao/[eventSlug]/card-payment-card.tsx'),
  read('src/app/pagamento/retorno/payment-return-client.tsx'),
  read('src/app/api/webhooks/asaas/route.ts'),
  read('src/lib/payments/asaas-provider.ts'),
  read('src/lib/checkout/pix-payment-status.ts'),
]);

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.ok(start >= 0, `bloco nao encontrado: ${startNeedle}`);
  const end = endNeedle ? source.indexOf(endNeedle, start + startNeedle.length) : -1;
  return source.slice(start, end === -1 ? undefined : end);
}

const pixAction = sliceBetween(
  actions,
  'export async function generatePublicOrderPixAction',
  'async function persistOrderCardCharge',
);
const persistHelper = sliceBetween(
  actions,
  'async function persistOrderCardCharge',
  'async function withHydratedCardCheckoutUrl',
);
const cardAction = sliceBetween(
  actions,
  'export async function generatePublicOrderCardAction',
  'export async function simulateFakeOrderPaymentAction',
);

test('checkout de ingresso/pacote: pedido nasce na rota /inscricao/[eventSlug] via create_multi_ticket_order_checkout', () => {
  assert.match(actions, /create_multi_ticket_order_checkout/);
  assert.match(wizard, /generatePublicOrderCardAction/);
  assert.match(wizard, /handleCartFinalized/);
});

test('cobranca Asaas criada com sucesso + URL retornada: frontend recebe sucesso e redireciona para checkout_url', () => {
  assert.match(cardAction, /payload = await gateway\.createCardPayment\(/);
  assert.match(cardAction, /persistOrderCardCharge\(/);
  assert.match(cardAction, /checkout_url: persisted\.payment\.checkout_url \|\| payload\.checkoutUrl \|\| null/);
  assert.match(wizard, /const nextCheckout = card\.payment\.checkout_url \? String\(card\.payment\.checkout_url\) : ''/);
  assert.match(wizard, /window\.location\.assign\(nextCheckout\)/);
  assert.doesNotMatch(wizard, /card\.payment\.invoiceUrl|card\.payment\.invoice_url/);
});

test('cobranca criada nao e tratada como falha so porque invoiceUrl veio atrasado', () => {
  assert.match(provider, /const checkoutUrl = await this\.resolveInvoiceUrl\(payment\)/);
  assert.match(provider, /const recovered = await this\.findOpenCardPaymentByOrderId/);
  assert.doesNotMatch(provider, /if \(!checkoutUrl\) throw/);
  assert.doesNotMatch(provider, /throw new Error\("Asaas API error \(\/payments\): cobranca de cartao sem invoiceUrl/);
  assert.match(cardAction, /if \(payload\.providerPaymentId\) \{/);
  assert.match(cardAction, /success: true as const/);
});

test('URL correta e persistida e propagada ate a UI', () => {
  assert.match(persistHelper, /p_checkout_url: input\.payload\.checkoutUrl/);
  assert.match(persistHelper, /p_gateway_payment_id: input\.payload\.providerPaymentId/);
  assert.match(cardAction, /checkout_url: payload\.checkoutUrl \|\| payment\.checkout_url/);
  assert.match(cardCard, /checkoutUrl/);
  assert.match(cardCard, /pagina segura do Asaas/);
});

test('gateway_payment_id e persistido apos createCardPayment, inclusive se a URL ainda estiver vazia', () => {
  assert.match(persistHelper, /p_gateway_payment_id: input\.payload\.providerPaymentId/);
  assert.match(cardAction, /const persisted = await persistOrderCardCharge/);
  const createIndex = cardAction.indexOf('gateway.createCardPayment');
  const persistIndex = cardAction.indexOf('persistOrderCardCharge');
  assert.ok(createIndex >= 0 && persistIndex > createIndex);
});

test('segunda tentativa nao duplica cobranca CREDIT_CARD valida', () => {
  assert.match(provider, /findOpenCardPaymentByOrderId\(input\.orderId\)/);
  assert.match(provider, /toUpperCase\(\) !== "CREDIT_CARD"/);
  assert.match(cardAction, /withHydratedCardCheckoutUrl\(/);
  assert.match(cardAction, /if \(claimAction === \"reuse\"\) \{/);
  const reuseIndex = cardAction.indexOf('if (claimAction === "reuse")');
  const cancelIndex = cardAction.indexOf('await cancelPreviousGatewayCharge');
  assert.ok(reuseIndex >= 0 && cancelIndex > reuseIndex);
  assert.match(cardAction, /isLiveCardGatewayStatus\(hydrated\.gatewayStatus\)/);
  assert.match(cardAction, /hydrated\.gatewayStatus === \"paid\"/);
});

test('erro antes da criacao libera o claim e permite tentar novamente', () => {
  assert.match(cardAction, /release_order_pix_generation/);
  assert.match(cardAction, /Nao foi possivel iniciar o pagamento com cartao\. Tente novamente em instantes\./);
  const catchIndex = cardAction.indexOf('catch (gatewayError)');
  const messageIndex = cardAction.indexOf('Nao foi possivel iniciar o pagamento com cartao');
  assert.ok(catchIndex >= 0 && messageIndex > catchIndex);
  assert.equal(
    (cardAction.match(/Nao foi possivel iniciar o pagamento com cartao/g) ?? []).length,
    1,
  );
});

test('erro depois da criacao preserva a cobranca existente e nao cancela orfao', () => {
  assert.doesNotMatch(cardAction, /cancelOrphanGatewayCharge/);
  assert.match(cardAction, /persist_card_charge_failed/);
  assert.match(cardAction, /gateway_payment_id: payload\.providerPaymentId/);
  assert.match(cardAction, /payment_status: \"pending\"/);
});

test('webhook posterior reconcilia pelo gateway_payment_id persistido', () => {
  assert.match(webhook, /apply_gateway_payment_status/);
  assert.match(webhook, /p_provider_payment_id: event\.providerPaymentId/);
  assert.match(webhook, /PAYMENT_NOT_FOUND/);
  assert.match(persistHelper, /p_gateway_payment_id: input\.payload\.providerPaymentId/);
});

test('retentativa do wizard e da tela de retorno chama a mesma action idempotente', () => {
  assert.match(wizard, /async function handleRetryCard\(\)/);
  assert.match(wizard, /redirectToHostedCardCheckout\(registration\.order_id, registration\.payment, \{ force: true \}\)/);
  assert.match(returnClient, /const result = await generatePublicOrderCardAction\(orderId\)/);
  assert.match(cardCard, /Tentar pagamento novamente/);
});

test('PIX do checkout de ingresso permanece intacto', () => {
  assert.match(pixAction, /createPixPayment\(/);
  assert.match(pixAction, /cancelOrphanGatewayCharge/);
  assert.match(pixAction, /p_pix_code: payload\.pixCode/);
  assert.doesNotMatch(pixAction, /persistOrderCardCharge/);
  assert.doesNotMatch(pixAction, /createCardPayment/);
  assert.match(wizard, /generatePublicOrderPixAction/);
});

test('reuso local exige cobranca viva; hidratacao cobre id persistido sem checkout_url', () => {
  assert.match(pixStatus, /if \(!hasPix && !hasCheckout\) return false/);
  assert.match(actions, /async function withHydratedCardCheckoutUrl/);
  assert.match(cardAction, /if \(payment\.gateway_payment_id && String\(payment\.payment_status \?\? \"\"\)\.toLowerCase\(\) === \"pending\"\)/);
  assert.match(actions, /function isLiveCardGatewayStatus/);
  assert.match(actions, /if \(gatewayStatus === \"paid\"\)/);
  assert.match(actions, /if \(!isLiveCardGatewayStatus\(gatewayStatus\)\)/);
});
