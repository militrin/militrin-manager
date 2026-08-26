import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAsaasPaymentStatus, isKnownAsaasPaymentStatus } from '../src/lib/payments/asaas-status-map.ts';

test('status aprovados da Asaas sempre convergem para paid', () => {
  assert.equal(mapAsaasPaymentStatus('RECEIVED'), 'paid');
  assert.equal(mapAsaasPaymentStatus('CONFIRMED'), 'paid');
  assert.equal(mapAsaasPaymentStatus('RECEIVED_IN_CASH'), 'paid');
});

test('pending e status de risco nunca emitem ticket (mapeiam para pending/processing)', () => {
  assert.equal(mapAsaasPaymentStatus('PENDING'), 'pending');
  assert.equal(mapAsaasPaymentStatus('AWAITING_RISK_ANALYSIS'), 'processing');
});

test('OVERDUE nunca emite ticket -- mapeia para expired', () => {
  assert.equal(mapAsaasPaymentStatus('OVERDUE'), 'expired');
});

test('estorno e chargeback nunca mapeiam para paid', () => {
  assert.equal(mapAsaasPaymentStatus('REFUNDED'), 'refunded');
  assert.equal(mapAsaasPaymentStatus('PARTIALLY_REFUNDED'), 'refunded');
  assert.equal(mapAsaasPaymentStatus('CHARGEBACK_REQUESTED'), 'chargeback');
  assert.equal(mapAsaasPaymentStatus('CHARGEBACK_DISPUTE'), 'chargeback');
  assert.equal(mapAsaasPaymentStatus('AWAITING_CHARGEBACK_REVERSAL'), 'chargeback');
});

test('status desconhecido/futuro da Asaas nunca vira paid silenciosamente', () => {
  assert.equal(mapAsaasPaymentStatus('UM_STATUS_QUE_NAO_EXISTE_AINDA'), 'processing');
  assert.equal(mapAsaasPaymentStatus(null), 'processing');
  assert.equal(mapAsaasPaymentStatus(undefined), 'processing');
  assert.equal(mapAsaasPaymentStatus(''), 'processing');
});

test('normaliza case e espacos', () => {
  assert.equal(mapAsaasPaymentStatus('  received  '), 'paid');
  assert.equal(mapAsaasPaymentStatus('confirmed'), 'paid');
});

test('isKnownAsaasPaymentStatus distingue status documentados de desconhecidos', () => {
  assert.equal(isKnownAsaasPaymentStatus('RECEIVED'), true);
  assert.equal(isKnownAsaasPaymentStatus('NAO_EXISTE'), false);
});
