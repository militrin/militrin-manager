import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePaymentStatus,
  resolvePixDisplayStatus,
  canRegeneratePix,
  formatPixCountdown,
  isReusableLiveGatewayCharge,
  isReusableLivePix,
  canReuseCardCheckout,
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

test('canRegeneratePix permite gerar novo PIX enquanto pending ou expired, nunca sobre cancelled/paid', () => {
  assert.equal(canRegeneratePix('pending'), true);
  assert.equal(canRegeneratePix('expired'), true);
  assert.equal(canRegeneratePix('cancelled'), false);
  assert.equal(canRegeneratePix('paid'), false);
});

test('formatPixCountdown formata mm:ss com zero a esquerda nos segundos', () => {
  assert.equal(formatPixCountdown(0), '0:00');
  assert.equal(formatPixCountdown(5), '0:05');
  assert.equal(formatPixCountdown(65), '1:05');
  assert.equal(formatPixCountdown(7200), '120:00');
});

test('cobranca marcada como nao reutilizavel nunca volta a ser usada', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(isReusableLivePix({
    payment_status: 'pending', pix_code: 'PIX', expires_at: future, gateway_charge_reusable: false,
  }), false);
  assert.equal(isReusableLiveGatewayCharge({
    payment_status: 'pending',
    pix_code: 'PIX',
    gateway_payment_id: 'pay_1',
    expires_at: future,
    gateway_charge_reusable: false,
  }), false);
  assert.equal(isReusableLiveGatewayCharge({
    payment_status: 'pending',
    pix_code: 'PIX',
    gateway_payment_id: 'pay_1',
    expires_at: future,
    gateway_charge_reusable: true,
  }), true);
});

test('canReuseCardCheckout reabre invoice viva e recusa cobranca deletada ou expirada', () => {
  const now = new Date('2026-09-05T15:00:00.000Z');
  const future = '2026-09-05T16:00:00.000Z';
  const past = '2026-09-05T14:00:00.000Z';
  assert.equal(canReuseCardCheckout({
    payment_status: 'pending',
    checkout_url: 'https://sandbox.asaas.com/i/abc',
    expires_at: future,
    gateway_charge_reusable: true,
    now,
  }), true);
  assert.equal(canReuseCardCheckout({
    payment_status: 'pending',
    checkout_url: 'https://sandbox.asaas.com/i/abc',
    expires_at: future,
    gateway_charge_reusable: false,
    now,
  }), false);
  assert.equal(canReuseCardCheckout({
    payment_status: 'pending',
    checkout_url: null,
    expires_at: future,
    gateway_charge_reusable: true,
    now,
  }), false);
  assert.equal(canReuseCardCheckout({
    payment_status: 'pending',
    checkout_url: 'https://sandbox.asaas.com/i/abc',
    expires_at: past,
    gateway_charge_reusable: true,
    now,
  }), false);
  assert.equal(canReuseCardCheckout({
    payment_status: 'paid',
    checkout_url: 'https://sandbox.asaas.com/i/abc',
    expires_at: future,
    gateway_charge_reusable: true,
    now,
  }), false);
});
