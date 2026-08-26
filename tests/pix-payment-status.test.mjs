import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePaymentStatus,
  resolvePixDisplayStatus,
  canRegeneratePix,
  formatPixCountdown,
} from '../src/lib/checkout/pix-payment-status.ts';

test('normaliza status crus do banco para os 5 estados de apresentacao, nunca a string tecnica', () => {
  assert.equal(normalizePaymentStatus('pending'), 'pending');
  assert.equal(normalizePaymentStatus('processing'), 'pending');
  assert.equal(normalizePaymentStatus('paid'), 'paid');
  assert.equal(normalizePaymentStatus('expired'), 'expired');
  assert.equal(normalizePaymentStatus('cancelled'), 'cancelled');
  assert.equal(normalizePaymentStatus('canceled'), 'cancelled');
  assert.equal(normalizePaymentStatus('algo-desconhecido'), 'error');
  assert.equal(normalizePaymentStatus(null), 'error');
  assert.equal(normalizePaymentStatus(undefined), 'error');
});

test('pending com contador positivo mostra QR ativo (nao expirado)', () => {
  assert.equal(resolvePixDisplayStatus('pending', 120), 'pending');
  assert.equal(resolvePixDisplayStatus('pending', 1), 'pending');
});

test('pending sem prazo aplicavel (countdownSeconds null) continua mostrando QR ativo', () => {
  assert.equal(resolvePixDisplayStatus('pending', null), 'pending');
});

test('contador chegando a zero com banco ainda pending vira expirado (soft expire) na tela', () => {
  assert.equal(resolvePixDisplayStatus('pending', 0), 'expired');
  assert.equal(resolvePixDisplayStatus('pending', -5), 'expired');
});

test('banco ja confirmado expired sempre e expirado, independente do contador', () => {
  assert.equal(resolvePixDisplayStatus('expired', 500), 'expired');
  assert.equal(resolvePixDisplayStatus('expired', null), 'expired');
});

test('paid sempre mostra confirmado, mesmo que o contador ja tenha zerado', () => {
  assert.equal(resolvePixDisplayStatus('paid', 0), 'paid');
  assert.equal(resolvePixDisplayStatus('paid', -100), 'paid');
});

test('cancelled sempre mostra cancelado', () => {
  assert.equal(resolvePixDisplayStatus('cancelled', 500), 'cancelled');
});

test('status desconhecido cai em erro (nunca finge que esta tudo bem)', () => {
  assert.equal(resolvePixDisplayStatus('algo-novo-que-a-asaas-inventou', 100), 'error');
});

test('canRegeneratePix so permite gerar novo PIX quando o banco ainda diz pending -- nunca sobre expired/cancelled/paid confirmados', () => {
  assert.equal(canRegeneratePix('pending'), true);
  assert.equal(canRegeneratePix('expired'), false);
  assert.equal(canRegeneratePix('cancelled'), false);
  assert.equal(canRegeneratePix('paid'), false);
});

test('formatPixCountdown formata mm:ss com zero a esquerda nos segundos', () => {
  assert.equal(formatPixCountdown(0), '0:00');
  assert.equal(formatPixCountdown(5), '0:05');
  assert.equal(formatPixCountdown(65), '1:05');
  assert.equal(formatPixCountdown(7200), '120:00');
});
