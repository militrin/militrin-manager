import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canRegisterOffGatewayPayment,
  deriveSettlementNature,
  formatSettlementMethodLabel,
  matchesSalesSettlementFilter,
  resolveSettlementNature,
} from '../src/lib/finance/settlement-nature.ts';

test('I: cupom 100% com payment_method pix classifica Cupom 100%, nao PIX recebido', () => {
  const coupon = {
    payment_status: 'paid',
    payment_method: 'pix',
    amount: 200,
    discount_amount: 200,
    final_amount: 0,
  };
  assert.equal(deriveSettlementNature(coupon), 'coupon_zero');
  assert.equal(formatSettlementMethodLabel(coupon), 'Cupom 100%');
  assert.equal(canRegisterOffGatewayPayment(coupon).allowed, false);
  assert.equal(matchesSalesSettlementFilter(coupon, 'pix_asaas'), false);
  assert.equal(matchesSalesSettlementFilter(coupon, 'pix_off_gateway'), false);
  assert.equal(matchesSalesSettlementFilter(coupon, 'coupon_zero'), true);
});

test('J: cortesia normal continua courtesy', () => {
  const courtesy = {
    payment_status: 'paid',
    payment_method: 'courtesy',
    amount: 200,
    discount_amount: 200,
    final_amount: 0,
  };
  assert.equal(resolveSettlementNature(courtesy), 'courtesy');
  assert.match(formatSettlementMethodLabel(courtesy), /Cortesia/);
  assert.equal(canRegisterOffGatewayPayment(courtesy).allowed, true);
  assert.equal(canRegisterOffGatewayPayment(courtesy).replace, false);
});

test('PIX Asaas nao usa payment_method sozinho', () => {
  const asaas = {
    payment_status: 'paid',
    payment_method: 'pix',
    provider: 'asaas',
    gateway_payment_id: 'pay_abc',
    gateway_account_key: 'asaas-conta-live-01',
    gateway_environment: 'production',
    final_amount: 215,
  };
  assert.equal(resolveSettlementNature(asaas), 'gateway');
  assert.equal(formatSettlementMethodLabel(asaas), 'PIX · Asaas');
  assert.equal(canRegisterOffGatewayPayment(asaas).allowed, false);
});

test('off_gateway gravado vence payment_method courtesy', () => {
  const row = {
    payment_status: 'paid',
    payment_method: 'courtesy',
    settlement_nature: 'courtesy',
    off_gateway_method: 'pix',
    off_gateway_amount: 215,
    off_gateway_recorded_at: '2026-09-20T12:00:00.000Z',
    final_amount: 0,
  };
  assert.equal(resolveSettlementNature(row), 'off_gateway');
  assert.equal(formatSettlementMethodLabel(row), 'PIX · Fora do gateway');
  assert.equal(canRegisterOffGatewayPayment(row).allowed, true);
  assert.equal(canRegisterOffGatewayPayment(row).replace, true);
});
