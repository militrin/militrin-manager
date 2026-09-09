import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectAsaasAccessTokenEnvironment,
  gatewayEnvironmentLabel,
  resolveGatewayEnvironment,
} from '../src/lib/payments/gateway-environment.ts';
import {
  isAsaasRefundedEvent,
  mapAsaasWebhookProviderStatus,
  mapAsaasWebhookToInternalStatus,
} from '../src/lib/payments/asaas-status-map.ts';
import { parseAsaasWebhookPayload } from '../src/lib/payments/asaas-provider.ts';

test('token Asaas $aact_hmlg_ e sandbox; $aact_prod_ e production', () => {
  assert.equal(detectAsaasAccessTokenEnvironment('$aact_hmlg_0000'), 'sandbox');
  assert.equal(detectAsaasAccessTokenEnvironment('$aact_prod_0000'), 'production');
  assert.equal(detectAsaasAccessTokenEnvironment('not-a-token'), null);
});

test('account_key persistido classifica ambiente sem heuristica de pessoa', () => {
  assert.equal(resolveGatewayEnvironment({ gateway_account_key: 'asaas-conta-live-01' }), 'production');
  assert.equal(resolveGatewayEnvironment({ gateway_account_key: 'asaas-sandbox-militrin' }), 'sandbox');
  assert.equal(gatewayEnvironmentLabel('production'), 'LIVE');
  assert.equal(gatewayEnvironmentLabel('sandbox'), 'SANDBOX');
});

test('coluna persistida prevalece sobre account_key', () => {
  assert.equal(resolveGatewayEnvironment({
    gateway_environment: 'production',
    gateway_account_key: 'asaas-sandbox-militrin',
  }), 'production');
});

test('PAYMENT_PARTIALLY_REFUNDED com payment.status RECEIVED vira refunded', () => {
  assert.equal(isAsaasRefundedEvent('PAYMENT_PARTIALLY_REFUNDED'), true);
  assert.equal(mapAsaasWebhookToInternalStatus('PAYMENT_PARTIALLY_REFUNDED', 'RECEIVED'), 'refunded');
  assert.equal(mapAsaasWebhookProviderStatus('PAYMENT_PARTIALLY_REFUNDED', 'RECEIVED'), 'PARTIALLY_REFUNDED');
  const parsed = parseAsaasWebhookPayload(JSON.stringify({
    id: 'evt_partial',
    event: 'PAYMENT_PARTIALLY_REFUNDED',
    payment: { id: 'pay_jvw5ergwu7ac91mx', status: 'RECEIVED' },
  }));
  assert.equal(parsed.status, 'refunded');
  assert.equal(parsed.providerStatus, 'PARTIALLY_REFUNDED');
});

test('PAYMENT_REFUNDED e reconhecido mesmo com status CONFIRMED no payload', () => {
  const parsed = parseAsaasWebhookPayload(JSON.stringify({
    id: 'evt_refund',
    event: 'PAYMENT_REFUNDED',
    payment: { id: 'pay_l09t47wzg0g7r1hf', status: 'CONFIRMED' },
  }));
  assert.equal(parsed.status, 'refunded');
  assert.equal(parsed.providerStatus, 'REFUNDED');
});

test('evento repetido de refund continua mapeando para refunded (idempotente no status)', () => {
  const first = mapAsaasWebhookToInternalStatus('PAYMENT_PARTIALLY_REFUNDED', 'RECEIVED');
  const second = mapAsaasWebhookToInternalStatus('PAYMENT_PARTIALLY_REFUNDED', 'RECEIVED');
  assert.equal(first, 'refunded');
  assert.equal(second, 'refunded');
});
