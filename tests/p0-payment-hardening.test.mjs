import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AsaasPaymentProvider, parseAsaasWebhookPayload } from '../src/lib/payments/asaas-provider.ts';
import {
  assertPositiveGatewayAmount,
  expectedGatewayAmountFromPayment,
  gatewayAmountMatchesExpected,
  parseAsaasGatewayAmount,
} from '../src/lib/payments/gateway-amount.ts';
import { GatewayChargeUnpersistedError } from '../src/lib/payments/gateway-charge-unpersisted.ts';
import { buildCheckoutIntentKey } from '../src/lib/checkout/checkout-intent-key.ts';
import { formatImportedPaymentMethod } from '../src/lib/imports/payment-method.ts';
import { resolveOperationalPaymentState } from '../src/lib/operations/payment-operational-state.ts';

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), 'utf8').then((text) => text.replace(/\r\n/g, '\n'));

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status });
}

function asaasProvider() {
  return new AsaasPaymentProvider({
    apiKey: 'test-key',
    webhookToken: 'wh',
    environment: 'sandbox',
    accountKey: 'conta-pix',
  });
}

const pixInput = {
  organizationId: 'org',
  orderId: 'order-1',
  paymentId: 'pay-local',
  amount: 216.99,
  dueDate: '2026-09-21',
  payer: { name: 'Ana', email: 'ana@example.com', cpfCnpj: '52998224725' },
};

test('A/regra: expected gateway amount usa final_amount com taxa, nao o subtotal', () => {
  assert.equal(expectedGatewayAmountFromPayment({ amount: 215, final_amount: 216.99 }), 216.99);
  assert.equal(gatewayAmountMatchesExpected(216.99, 216.99), true);
  assert.equal(gatewayAmountMatchesExpected(216.99, 215), false);
  assert.equal(gatewayAmountMatchesExpected(216.99, 0), false);
});

test('B/C: webhook extrai payment.value e o apply recebe p_gateway_amount', async () => {
  const parsedZero = parseAsaasWebhookPayload(JSON.stringify({
    id: 'evt_zero',
    event: 'PAYMENT_RECEIVED',
    payment: { id: 'pay_1', status: 'RECEIVED', value: 0 },
  }));
  assert.equal(parsedZero.amount, 0);
  assert.equal(parseAsaasGatewayAmount(parsedZero.amount), 0);

  const parsedMismatch = parseAsaasWebhookPayload(JSON.stringify({
    id: 'evt_low',
    event: 'PAYMENT_CONFIRMED',
    payment: { id: 'pay_1', status: 'CONFIRMED', value: 215 },
  }));
  assert.equal(parsedMismatch.amount, 215);

  const webhook = await read('src/app/api/webhooks/asaas/route.ts');
  assert.match(webhook, /p_gateway_amount: gatewayAmount/);
  const migration = await read('supabase/migrations/20261108000000_payment_amount_guard_and_idempotency.sql');
  assert.match(migration, /payment_gateway_amount_mismatch/);
  assert.match(migration, /v_gateway_amount is distinct from v_expected_amount/);
});

test('G: provider PIX amount=0 e bloqueado e nao chama Asaas', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('fetch nao deveria ser chamado para amount 0');
  };
  try {
    await assert.rejects(
      () => asaasProvider().createPixPayment({ ...pixInput, amount: 0 }),
      /maior que zero/,
    );
    assert.throws(() => assertPositiveGatewayAmount(0, 'createPixPayment'), /maior que zero/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('H: provider cartao amount=0 e bloqueado', async () => {
  await assert.rejects(
    () => asaasProvider().createCardPayment({
      organizationId: 'org',
      orderId: 'order-card',
      paymentId: 'pay-local',
      amount: 0,
      dueDate: '2026-09-21',
      payer: pixInput.payer,
    }),
    /maior que zero/,
  );
  assert.throws(() => assertPositiveGatewayAmount(-1, 'createCardPayment'), /maior que zero/);
  const fake = await read('src/lib/payments/fake-gateway-provider.ts');
  assert.match(fake, /assertPositiveGatewayAmount\(input\.amount, "createCardPayment"\)/);
  assert.match(fake, /assertPositiveGatewayAmount\(input\.amount, "createPixPayment"\)/);
});

test('I: POST payment OK + QR fail cancela a cobranca recem-criada', async () => {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    const method = init?.method ?? 'GET';
    requests.push({ href, method });
    if (href.includes('/customers?')) return json({ data: [{ id: 'cus_1' }] });
    if (href.endsWith('/payments') && method === 'POST') {
      return json({
        id: 'pay_orphan',
        status: 'PENDING',
        value: 216.99,
        netValue: null,
        paymentDate: null,
        dueDate: '2026-09-21',
        billingType: 'PIX',
      });
    }
    if (href.includes('/pixQrCode')) return json({ errors: [{ description: 'qr fail' }] }, 500);
    if (href.includes('/payments/pay_orphan') && method === 'DELETE') return json({});
    throw new Error(`fetch inesperado: ${href}`);
  };
  try {
    await asaasProvider().createPixPayment(pixInput);
    assert.fail('deveria falhar no QR');
  } catch (error) {
    assert.equal(error instanceof GatewayChargeUnpersistedError, true);
    assert.equal(error.providerPaymentId, 'pay_orphan');
    assert.equal(error.cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests.some((row) => row.href.endsWith('/payments') && row.method === 'POST'), true);
  assert.equal(requests.some((row) => row.href.includes('/pixQrCode')), true);
  assert.equal(requests.some((row) => row.href.includes('/payments/pay_orphan') && row.method === 'DELETE'), true);
  const actions = await read('src/app/inscricao/actions.ts');
  assert.match(actions, /record_unpersisted_gateway_charge/);
  assert.match(actions, /Tente novamente neste mesmo pedido/);
});

test('J/K: chave de checkout e estavel e o retry reusa pedido pending', async () => {
  const first = buildCheckoutIntentKey({
    eventId: 'evt',
    categoryId: 'cat',
    cpf: '529.982.247-25',
    quantity: 1,
    paymentMethod: 'pix',
    couponCode: '',
    items: [{ pricing_gender: 'male', shirt_type: 'Camiseta', shirt_size: 'M', ownership_mode: 'self' }],
  });
  const second = buildCheckoutIntentKey({
    eventId: 'evt',
    categoryId: 'cat',
    cpf: '52998224725',
    quantity: 1,
    paymentMethod: 'pix',
    items: [{ pricing_gender: 'male', shirt_type: 'Camiseta', shirt_size: 'M', ownership_mode: 'self' }],
  });
  assert.equal(first, second);
  const wizard = await read('src/app/inscricao/[eventSlug]/wizard.tsx');
  assert.match(wizard, /buildCheckoutIntentKey/);
  assert.doesNotMatch(wizard, /client_request_id: `\$\{event\.id\}:\$\{effectiveCategoryId \?\? 'single'\}:\$\{removeCpfMask\(form\.cpf\)\}:\$\{form\.quantity\}:\$\{Date\.now\(\)\}`/);
  const migration = await read('supabase/migrations/20261108000000_payment_amount_guard_and_idempotency.sql');
  assert.match(migration, /find_recoverable_account_checkout_order_id/);
  assert.match(migration, /ux_orders_user_client_request_pending/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test('L/M/N: emissao manual exige confirmacao e usa idempotency key', async () => {
  const form = await read('src/app/ingressos/emitir/issue-ticket-form.tsx');
  const actions = await read('src/app/ingressos/emitir/actions.ts');
  const migration = await read('supabase/migrations/20261108000000_payment_amount_guard_and_idempotency.sql');
  assert.match(form, /requiresExistingTicketConfirmation/);
  assert.match(form, /Emitir mesmo assim/);
  assert.match(form, /intentAfterAcknowledgeExisting\(result\.assignHolder === true\)/);
  assert.doesNotMatch(form, /submit\(true,\s*true\)/);
  assert.match(form, /idempotencyKeyRef/);
  assert.match(actions, /p_acknowledge_existing/);
  assert.match(actions, /p_idempotency_key/);
  assert.match(migration, /EXISTING_OPERATIONAL_TICKET/);
  assert.match(migration, /manual_ticket_issue_requests/);
});

test('E/F/cortesia: cupom 100% e cortesia administrativa nao passam pelo gateway', async () => {
  const checkout = await read('src/app/inscricao/actions.ts');
  assert.match(checkout, /if \(payment\.final_amount <= 0\)/);
  assert.match(checkout, /Pagamento nao necessario para este pedido/);
  assert.equal(formatImportedPaymentMethod('courtesy'), 'Cortesia / emissão administrativa');
  const state = resolveOperationalPaymentState({
    paymentStatus: 'paid',
    paymentMethod: 'courtesy',
    ticketStatus: 'active',
  });
  assert.equal(state.kind, 'courtesy');
  assert.match(state.label, /Cortesia \/ emissão administrativa/);
});

test('UX retry PIX no mesmo pedido', async () => {
  const pixCard = await read('src/app/inscricao/[eventSlug]/pix-payment-card.tsx');
  assert.match(pixCard, /Tentar gerar PIX novamente/);
});
