import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  storeActions,
  cartPage,
  storeCart,
  lojaPage,
  lojaHistory,
  orderPage,
  orderActions,
  accountOrdersHelper,
  comprasPage,
] = await Promise.all([
  read('src/lib/store/actions.ts'),
  read('src/app/minha-conta/carrinho/cart-page-client.tsx'),
  read('src/components/store/StoreCart.tsx'),
  read('src/app/minha-conta/loja/page.tsx'),
  read('src/app/minha-conta/loja/account-store-orders.tsx'),
  read('src/app/minha-conta/compras/loja/[storeOrderId]/page.tsx'),
  read('src/app/minha-conta/compras/loja/store-order-actions.tsx'),
  read('src/lib/store/get-account-store-orders.ts'),
  read('src/app/minha-conta/compras/page.tsx'),
]);

test('PIX: pedido nasce em create_store_order e o checkout ja inicia o PIX na mesma action', () => {
  assert.match(storeActions, /supabase\.rpc\("create_store_order"/);
  assert.match(storeActions, /p_payment_method: input\.paymentMethod/);
  assert.match(storeActions, /startStoreGatewayPayment\(/);
  assert.match(storeActions, /createPixPayment/);
  assert.match(storeActions, /persistStoreGatewayCharge/);
  assert.match(storeActions, /p_payment_method: input\.paymentMethod/);
  const createIndex = storeActions.indexOf('export async function createAccountStoreOrderAction');
  const startIndex = storeActions.indexOf('const started = await startStoreGatewayPayment', createIndex);
  const pixIndex = storeActions.indexOf('if (input.paymentMethod === "pix")');
  assert.ok(createIndex >= 0 && startIndex > createIndex);
  assert.ok(pixIndex >= 0 && pixIndex < startIndex);
});

test('PIX: carrinho nao chama generateStoreOrderPixAction de novo e redireciona para a ficha do pedido', () => {
  assert.doesNotMatch(cartPage, /generateStoreOrderPixAction/);
  assert.match(cartPage, /accountStoreOrderHref\(response\.storeOrderId\)/);
  assert.match(cartPage, /router\.replace\(orderHref\)/);
  assert.doesNotMatch(cartPage, /router\.push\(orderHref\)/);
  assert.doesNotMatch(storeCart, /generateStoreOrderPixAction/);
  assert.match(storeCart, /accountStoreOrderHref\(response\.storeOrderId\)/);
  assert.match(storeCart, /router\.replace\(orderHref\)/);
});

test('PIX: ficha canonica mostra numero, valor, status, QR, copia e cola, expiracao, cancelar e voltar para Loja', () => {
  assert.match(orderPage, /Pedido \$\{orderDisplayReference/);
  assert.match(orderPage, /Valor final:/);
  assert.match(orderPage, /MilitrinStatusBadge status=\{status\}/);
  assert.match(orderPage, /PixCodeBox code=\{String\(order\.pix_code\)\}/);
  assert.match(orderPage, /QR Code PIX/);
  assert.match(orderPage, /Expira em:/);
  assert.match(orderPage, /Voltar para Loja/);
  assert.match(orderPage, /href="\/minha-conta\/loja"/);
  assert.match(orderActions, /Cancelar pedido/);
});

test('PIX: historico da Loja lista o pedido do usuario sem filtrar por evento nem por pago', () => {
  assert.match(lojaPage, /getAccountStoreOrders\(supabase, user\.id\)/);
  assert.match(accountOrdersHelper, /\.eq\('user_id', userId\)/);
  assert.doesNotMatch(accountOrdersHelper, /payment_status.*paid/);
  assert.doesNotMatch(lojaPage, /ordersQuery\.eq\('event_id'/);
  assert.match(lojaHistory, /accountStoreOrderHref\(order\.id\)/);
  assert.match(lojaHistory, /PixCodeBox/);
});

test('PIX: carrinho so e limpo depois que o pedido existe', () => {
  assert.match(cartPage, /if \(!\('storeOrderId' in response\) \|\| !response\.storeOrderId\) \{/);
  const errorReturn = cartPage.indexOf("setError(response.message)");
  const leaveIndex = cartPage.indexOf('onLeavingCheckout()');
  const replaceIndex = cartPage.indexOf('router.replace(orderHref)');
  const clearAfterReplace = cartPage.indexOf('clearEvent(eventId)', replaceIndex);
  assert.ok(errorReturn >= 0 && leaveIndex > errorReturn);
  assert.ok(replaceIndex > leaveIndex);
  assert.ok(clearAfterReplace > replaceIndex, 'limpar o carrinho so depois de iniciar a navegacao da ficha');
  assert.match(storeCart, /if \(!\('storeOrderId' in response\) \|\| !response\.storeOrderId\) \{/);
  const storeError = storeCart.indexOf("setError(response.message)");
  const storeReplace = storeCart.indexOf('router.replace(orderHref)');
  const storeClear = storeCart.indexOf('setCart({})', storeReplace);
  assert.ok(storeError >= 0 && storeReplace > storeError && storeClear > storeReplace);
});

test('checkout bem-sucedido nao renderiza "Seu carrinho está vazio" no meio do fluxo', () => {
  const leavingGuard = cartPage.indexOf('if (leavingCheckout)');
  const emptyRender = cartPage.indexOf('if (groups.length === 0)');
  assert.ok(leavingGuard >= 0 && emptyRender > leavingGuard, 'o guard de saida precisa vir antes do empty state');
  assert.match(cartPage, /if \(leavingCheckout\) \{\s*return null;/);
  assert.match(cartPage, /Seu carrinho está vazio/);
  assert.match(cartPage, /onLeavingCheckout=\{\(\) => setLeavingCheckout\(true\)\}/);
  const leaveCall = cartPage.indexOf('onLeavingCheckout()');
  const replaceIndex = cartPage.indexOf('router.replace(orderHref)');
  assert.ok(leaveCall >= 0 && leaveCall < replaceIndex);
});

test('Cartao: pedido e criado antes do Asaas e payment_method credit_card e persistido', () => {
  assert.match(storeActions, /createCardPayment/);
  assert.match(storeActions, /paymentMethod: "credit_card"/);
  assert.match(storeActions, /p_payment_method: input\.paymentMethod/);
  const createFn = storeActions.slice(storeActions.indexOf('export async function createAccountStoreOrderAction'));
  const createRpc = createFn.indexOf('supabase.rpc("create_store_order"');
  const startPay = createFn.indexOf('startStoreGatewayPayment');
  assert.ok(createRpc >= 0 && startPay > createRpc, 'create_store_order precisa acontecer antes de chamar o gateway');
  assert.match(storeActions, /successUrl: `\$\{appBaseUrl\(\)\}\/minha-conta\/compras\/loja\/\$\{input\.storeOrderId\}`/);
});

test('Cartao: erro de gateway depois do pedido NAO executa rollbackStoreOrder', () => {
  const createFn = storeActions.slice(storeActions.indexOf('export async function createAccountStoreOrderAction'));
  const gatewayFail = createFn.indexOf('if (!started.success)');
  const rollbackAfterFail = createFn.indexOf('rollbackStoreOrder(storeOrderId)', gatewayFail);
  const nextFn = createFn.indexOf('export async function generateStoreOrderPixAction');
  assert.ok(gatewayFail >= 0);
  assert.ok(rollbackAfterFail === -1 || rollbackAfterFail > nextFn, 'falha do gateway nao pode cancelar o pedido ja criado');
  assert.match(createFn, /storeOrderId,/);
  assert.match(createFn, /success: false as const/);
});

test('Cartao: pedido permanece consultavel e aparece no historico mesmo pendente', () => {
  assert.match(accountOrdersHelper, /\.eq\('user_id', userId\)/);
  assert.doesNotMatch(accountOrdersHelper, /\.eq\(['"]payment_status['"], ['"]paid['"]\)/);
  assert.doesNotMatch(accountOrdersHelper, /\.eq\(['"]status['"], ['"]confirmed['"]\)/);
  assert.match(lojaHistory, /payment_method === 'credit_card'/);
  assert.match(lojaHistory, /Cartão pendente ou em processamento/);
  assert.match(comprasPage, /getAccountStoreOrders/);
  assert.match(comprasPage, /\/minha-conta\/compras\/loja\/\$\{order\.id\}/);
});

test('Cartao: checkout leva o usuario ao Asaas quando ha checkoutUrl, senao para a ficha', () => {
  assert.match(cartPage, /paymentMethod === 'credit_card' && response\.payment\?\.checkoutUrl/);
  assert.match(cartPage, /window\.location\.assign\(response\.payment\.checkoutUrl\)/);
  assert.match(orderPage, /gateway_checkout_url/);
  assert.match(orderPage, /Pagar com cartão/);
  assert.match(orderPage, /pendente ou em processamento/);
});

test('Cartao: falha do gateway nao esconde o pedido e permite nova tentativa', () => {
  assert.match(orderPage, /needsPaymentRetry/);
  assert.match(orderActions, /startAccountStoreOrderPaymentAction/);
  assert.match(orderActions, /Tentar pagamento do cartão/);
  assert.match(orderPage, /a página do cartão ainda não foi gerada/);
});

test('rota canonica existente /minha-conta/compras/loja/[storeOrderId] e usada; nao cria /minha-conta/loja/pedidos', async () => {
  assert.match(accountOrdersHelper, /ACCOUNT_STORE_ORDER_PATH = '\/minha-conta\/compras\/loja'/);
  await access(new URL('../src/app/minha-conta/compras/loja/[storeOrderId]/page.tsx', import.meta.url));
  await assert.rejects(
    () => access(new URL('../src/app/minha-conta/loja/pedidos/[orderId]/page.tsx', import.meta.url)),
  );
});
