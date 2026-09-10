import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const storeActions = await readFile(new URL('../src/lib/store/actions.ts', import.meta.url), 'utf8');
const legacyProvider = await readFile(new URL('../src/lib/payments/get-provider.ts', import.meta.url), 'utf8');
const gatewayProvider = await readFile(new URL('../src/lib/payments/get-gateway-provider.ts', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../src/lib/payments/production-runtime.ts', import.meta.url), 'utf8');
const synthetic = await readFile(new URL('../src/lib/payments/synthetic-gateway-payload.ts', import.meta.url), 'utf8');
const fakeLegacy = await readFile(new URL('../src/lib/payments/fake-provider.ts', import.meta.url), 'utf8');
const fakeGateway = await readFile(new URL('../src/lib/payments/fake-gateway-provider.ts', import.meta.url), 'utf8');
const webhook = await readFile(new URL('../src/app/api/webhooks/asaas/route.ts', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261019000000_store_asaas_live_payments.sql', import.meta.url), 'utf8');
const cart = await readFile(new URL('../src/components/store/StoreCart.tsx', import.meta.url), 'utf8');
const panel = await readFile(new URL('../src/components/store/StorePaymentPanel.tsx', import.meta.url), 'utf8');
const storeOrderPage = await readFile(new URL('../src/app/minha-conta/compras/loja/[storeOrderId]/page.tsx', import.meta.url), 'utf8');
const adminConfirm = await readFile(new URL('../src/app/loja/actions.ts', import.meta.url), 'utf8');
const packagePix = await readFile(new URL('../src/app/inscricao/actions.ts', import.meta.url), 'utf8');

test('1. production sem credencial falha fechada e nao cria pedido que pareca real', () => {
  assert.match(runtime, /isProductionPaymentRuntime/);
  assert.match(runtime, /Pagamento indisponível no momento/);
  assert.match(storeActions, /assertStoreLiveGateway/);
  assert.match(storeActions, /assertStoreLiveGateway\(input\.paymentMethod\)/);
  assert.doesNotMatch(storeActions, /export function assertStoreLiveGateway/);
  assert.match(storeActions, /rollbackStoreOrder/);
  assert.match(gatewayProvider, /PAYMENT_PROVIDER=asaas e obrigatorio em producao/);
});

test('2. production nunca gera FAKE/mock na Loja', () => {
  assert.match(fakeLegacy, /6304FAKE/);
  assert.match(fakeGateway, /FAKEPIX/);
  assert.match(synthetic, /6304FAKE|FAKEPIX|PIX FICTICIO/);
  assert.match(storeActions, /isSyntheticGatewayPayload/);
  assert.match(storeActions, /gateway\.name !== "asaas"/);
  assert.doesNotMatch(storeActions, /getPaymentProvider\(/);
  assert.match(legacyProvider, /MILITRIN_PAYMENT_PROVIDER/);
});

test('3-5. Loja PIX e cartao usam provider canonico e persistem account key', () => {
  assert.match(storeActions, /getPaymentGatewayProviderForMethod\(method\)/);
  assert.match(storeActions, /createPixPayment/);
  assert.match(storeActions, /createCardPayment/);
  assert.match(storeActions, /getPaymentGatewayAccountKeyForMethod|getAsaasAccountCredentialsForMethod/);
  assert.match(storeActions, /p_gateway_account_key/);
  assert.match(storeActions, /p_gateway_environment/);
  assert.match(storeActions, /p_provider/);
  assert.match(migration, /gateway_account_key/);
  assert.match(migration, /gateway_environment/);
});

test('4. cartao da Loja e hospedado, sem PAN/CVV', () => {
  assert.match(storeActions, /createCardPayment/);
  assert.match(panel, /p[aá]gina segura do Asaas/);
  assert.doesNotMatch(panel, /autoComplete=['"]cc-/i);
  assert.doesNotMatch(panel, /name=['"]cvc|name=['"]cvv|name=['"]cardNumber/i);
  assert.doesNotMatch(cart, /autoComplete=['"]cc-/i);
  assert.match(panel, /checkoutUrl/);
});

test('6-7. webhook confirma Loja e pending nao vira pago sozinho', () => {
  assert.match(webhook, /apply_store_order_gateway_status/);
  assert.match(webhook, /PAYMENT_NOT_FOUND/);
  assert.match(migration, /store_order_payment_confirmed/);
  assert.match(panel, /webhook do Asaas|Pendente não vira pago/);
  assert.match(adminConfirm, /confirma só pelo webhook/);
});

test('8-9. expiracao/cancelamento libera reserva e recusa nao finaliza estoque', () => {
  assert.match(migration, /expire_expired_store_orders/);
  assert.match(migration, /release_store_item_reservation/);
  assert.match(migration, /PAYMENT_CREDIT_CARD_CAPTURE_REFUSED/);
  assert.match(migration, /last_gateway_attempt_status = 'refused'/);
  assert.match(storeActions, /cancel_store_order/);
});

test('10. historico resolve pela account key original', () => {
  assert.match(migration, /coalesce\(gateway_account_key, ''\) = v_expected/);
  assert.match(migration, /GATEWAY_ACCOUNT_MISMATCH/);
  assert.match(webhook, /p_expected_gateway_account_key: accountKey/);
});

test('11. checkout do pacote continua no gateway canonico', () => {
  assert.match(packagePix, /getPaymentGatewayProviderForMethod\('pix'\)/);
  assert.match(packagePix, /getPaymentGatewayProviderForMethod\('credit_card'\)/);
  assert.match(packagePix, /start_order_payment_pix/);
  assert.doesNotMatch(packagePix, /start_store_order_payment_pix/);
});

test('UI da Loja nao exibe payload FAKE', () => {
  assert.match(storeOrderPage, /isSyntheticGatewayPayload/);
  assert.match(storeOrderPage, /Este PIX não é uma cobrança real/);
  assert.match(panel, /syntheticPix/);
});
