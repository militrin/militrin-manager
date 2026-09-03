import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyAsaasWebhookToken } from '../src/lib/payments/asaas-webhook-token.ts';

test('webhook Asaas aceita token atual e o anterior; rejeita invalido', () => {
  const webhookToken = 'token-atual';
  const previousWebhookToken = 'token-anterior';

  assert.equal(verifyAsaasWebhookToken({ headers: { 'asaas-access-token': 'token-atual' }, webhookToken, previousWebhookToken }), true);
  assert.equal(verifyAsaasWebhookToken({ headers: { 'asaas-access-token': 'token-anterior' }, webhookToken, previousWebhookToken }), true);
  assert.equal(verifyAsaasWebhookToken({ headers: { 'asaas-access-token': 'outro' }, webhookToken, previousWebhookToken }), false);
  assert.equal(verifyAsaasWebhookToken({ headers: {}, webhookToken, previousWebhookToken }), false);
});
