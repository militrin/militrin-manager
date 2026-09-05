import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const webhook = await readFile(new URL('../src/app/api/webhooks/asaas/route.ts', import.meta.url), 'utf8');
const migration51 = await readFile(new URL('../supabase/migrations/20260951000000_asaas_card_multi_account.sql', import.meta.url), 'utf8');
const migration52 = await readFile(new URL('../supabase/migrations/20260952000000_asaas_card_blockers.sql', import.meta.url), 'utf8');
const cardCard = await readFile(new URL('../src/app/inscricao/[eventSlug]/card-payment-card.tsx', import.meta.url), 'utf8');
const provider = await readFile(new URL('../src/lib/payments/asaas-provider.ts', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/inscricao/actions.ts', import.meta.url), 'utf8');
const returnPage = await readFile(new URL('../src/app/pagamento/retorno/page.tsx', import.meta.url), 'utf8');
const returnClient = await readFile(new URL('../src/app/pagamento/retorno/payment-return-client.tsx', import.meta.url), 'utf8');
const pixStatus = await readFile(new URL('../src/lib/checkout/pix-payment-status.ts', import.meta.url), 'utf8');
const wizard = await readFile(new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url), 'utf8');
const statusMap = await readFile(new URL('../src/lib/payments/asaas-status-map.ts', import.meta.url), 'utf8');

test('webhook resolve conta pelo token e aplica com account_key esperada e tipo do evento', () => {
  assert.match(webhook, /resolveAsaasWebhookAccountKey/);
  assert.match(webhook, /p_expected_gateway_account_key: accountKey/);
  assert.match(webhook, /p_gateway_account_key: accountKey/);
  assert.match(webhook, /p_event_type: event.eventType/);
  assert.match(webhook, /GATEWAY_ACCOUNT_MISMATCH/);
  assert.doesNotMatch(webhook, /getPaymentGatewayProvider\(/);
});

test('dedup de webhook inclui account_key', () => {
  assert.match(migration51, /ux_payment_gateway_events_provider_account_event/);
  assert.match(migration51, /coalesce\(gateway_account_key, ''\)/);
});

test('unique de cobranca inclui account_key e tabela de charges do parcelamento', () => {
  assert.match(migration52, /drop index if exists public.ux_payments_provider_gateway_payment_id/);
  assert.match(migration52, /ux_payments_provider_account_gateway_payment_id/);
  assert.match(migration52, /ux_payment_gateway_charges_provider_account_pay/);
  assert.match(migration52, /payment_gateway_charges/);
  assert.match(migration52, /PAYMENT_CREDIT_CARD_CAPTURE_REFUSED/);
  assert.match(migration52, /PAYMENT_DELETED/);
});

test('checkout de cartao nao coleta PAN/CVV e permanece na mesma aba', () => {
  assert.doesNotMatch(cardCard, /<input[^>]*(name|id|autoComplete)=['"][^'"]*(card|ccv|cvv|pan)/i);
  assert.match(cardCard, /pagina segura do Asaas/);
  assert.doesNotMatch(cardCard, /target="_blank"/);
  assert.match(provider, /billingType: "CREDIT_CARD"/);
  assert.match(provider, /invoiceUrl/);
  assert.match(provider, /SEM objetos creditCard/);
  assert.match(provider, /autoRedirect: true/);
});

test('callback de retorno nao confirma pagamento e nao vaza pedido de outro usuario', () => {
  assert.match(actions, /cardPaymentReturnUrl\(orderId\)/);
  assert.match(returnPage, /get_cart_order_details/);
  assert.match(returnPage, /redirect\(`\/entrar\?next=/);
  assert.doesNotMatch(returnPage, /apply_gateway_payment_status|payment_status = 'paid'/);
  assert.match(returnPage, /expiresAt=/);
  assert.match(returnPage, /gatewayChargeReusable=/);
  assert.match(returnClient, /Pagamento ainda não confirmado/);
  assert.match(returnClient, /Se a tentativa não foi concluída, você pode tentar novamente/);
  assert.match(returnClient, /Tentar pagamento novamente/);
  assert.match(returnClient, /generatePublicOrderCardAction/);
  assert.match(returnClient, /canReuseCardCheckout/);
  assert.match(returnClient, /getPublicOrderPaymentStatusAction/);
  assert.match(returnClient, /Cartao recusado/);
  assert.doesNotMatch(returnClient, /Confirmando pagamento/);
});

test('pending de cartao sem refused usa UX neutra e recusa especifica permanece', () => {
  assert.match(cardCard, /Pagamento ainda não confirmado/);
  assert.match(cardCard, /Se a tentativa não foi concluída, você pode tentar novamente/);
  assert.match(cardCard, /Tentar pagamento novamente/);
  assert.match(cardCard, /Cartao recusado\. Tente novamente/);
  assert.match(cardCard, /canReuseInvoice/);
  assert.match(cardCard, /nunca failed/);
});

test('wizard reutiliza invoice viva e gera nova cobranca quando a atual nao serve', () => {
  const reuse = wizard.match(/canReuseInvoice=\{isReusableLiveGatewayCharge\(registration\.payment\)\}/g) ?? [];
  assert.equal(reuse.length, 2);
  assert.match(wizard, /window\.location\.assign\(nextCheckout\)/);
});

test('sandbox recusa sincrona permanece pending e nao inventa failed', () => {
  assert.match(statusMap, /sem emitir PAYMENT_CREDIT_CARD_CAPTURE_REFUSED/);
  assert.match(statusMap, /Nao marcar payment failed/);
  assert.match(statusMap, /nao inferir recusa por tempo/);
  assert.doesNotMatch(statusMap, /PENDING:\s*"failed"/);
});

test('cobranca deletada nao e reutilizada pelo checkout', () => {
  assert.match(pixStatus, /gateway_charge_reusable === false/);
  assert.match(migration52, /reusable = false/);
  assert.match(migration52, /PAYMENT_DELETED/);
});
