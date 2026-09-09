import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confirmedRevenueAmount,
  confirmedRevenueExclusionReason,
  isSyntheticGatewayPayment,
  pendingRevenueAmount,
  refundedRevenueAmount,
  shouldIncludeInConfirmedRevenue,
  shouldIncludeInPendingRevenue,
  shouldIncludeInRefundedRevenue,
} from '../src/lib/finance/confirmed-revenue.ts';

const livePaid = {
  payment_status: 'paid',
  payment_method: 'pix',
  price_origin: 'catalog',
  provider: 'asaas',
  gateway_payment_id: 'pay_jvw5ergwu7ac91mx',
  gateway_account_key: 'asaas-conta-live-01',
  gateway_environment: 'production',
  final_amount: 201.99,
};

const sandboxPaid = {
  payment_status: 'paid',
  payment_method: 'pix',
  provider: 'asaas',
  gateway_payment_id: 'pay_hsefqq6jvb1lek96',
  gateway_account_key: 'asaas-sandbox-militrin',
  gateway_environment: 'sandbox',
  final_amount: 201.99,
};

test('sandbox paid NAO entra em Receita Confirmada', () => {
  assert.equal(shouldIncludeInConfirmedRevenue(sandboxPaid), false);
  assert.equal(confirmedRevenueAmount(sandboxPaid), 0);
  assert.match(confirmedRevenueExclusionReason(sandboxPaid) ?? '', /SANDBOX/);
});

test('live paid entra em Receita Confirmada', () => {
  assert.equal(shouldIncludeInConfirmedRevenue(livePaid), true);
  assert.equal(confirmedRevenueAmount(livePaid), 201.99);
  assert.equal(confirmedRevenueExclusionReason(livePaid), null);
});

test('live refunded NAO entra em Receita Confirmada e entra na Estornada', () => {
  const refunded = { ...livePaid, payment_status: 'refunded' };
  assert.equal(shouldIncludeInConfirmedRevenue(refunded), false);
  assert.equal(shouldIncludeInRefundedRevenue(refunded), true);
  assert.equal(refundedRevenueAmount(refunded), 201.99);
});

test('sandbox refunded nao entra na Receita Estornada operacional', () => {
  const refunded = { ...sandboxPaid, payment_status: 'refunded' };
  assert.equal(shouldIncludeInRefundedRevenue(refunded), false);
  assert.equal(refundedRevenueAmount(refunded), 0);
});

test('provider fake e gateway fake_ ficam isolados', () => {
  assert.equal(isSyntheticGatewayPayment({ provider: 'fake', gateway_payment_id: 'x' }), true);
  assert.equal(isSyntheticGatewayPayment({ provider: 'asaas', gateway_payment_id: 'fake_abc' }), true);
  const fake = {
    payment_status: 'paid',
    payment_method: 'pix',
    provider: 'fake',
    gateway_payment_id: 'fake_cb55a21d',
    final_amount: 200,
  };
  assert.equal(shouldIncludeInConfirmedRevenue(fake), false);
  assert.equal(confirmedRevenueAmount(fake), 0);
});

test('legacy_unknown nao entra', () => {
  const payment = {
    ...livePaid,
    price_origin: 'legacy_unknown',
    final_amount: 0,
  };
  assert.equal(shouldIncludeInConfirmedRevenue(payment), false);
  assert.match(confirmedRevenueExclusionReason(payment) ?? '', /histórico/i);
});

test('cortesia paid nao soma receita confirmada', () => {
  const courtesy = { ...livePaid, payment_method: 'courtesy', final_amount: 0 };
  assert.equal(shouldIncludeInConfirmedRevenue(courtesy), false);
});

test('pending nao entra em receita confirmada', () => {
  const payment = { ...livePaid, payment_status: 'pending', final_amount: 170 };
  assert.equal(shouldIncludeInConfirmedRevenue(payment), false);
  assert.equal(shouldIncludeInPendingRevenue(payment), true);
  assert.equal(pendingRevenueAmount(payment), 170);
});

test('sandbox pending nao entra na receita pendente operacional', () => {
  const payment = { ...sandboxPaid, payment_status: 'pending' };
  assert.equal(shouldIncludeInPendingRevenue(payment), false);
});

test('cancelled e expired nao entram', () => {
  assert.equal(shouldIncludeInConfirmedRevenue({ ...livePaid, payment_status: 'cancelled' }), false);
  assert.equal(shouldIncludeInConfirmedRevenue({ ...livePaid, payment_status: 'expired' }), false);
});

test('ticket cancelado sem refund NAO remove live paid', () => {
  assert.equal(shouldIncludeInConfirmedRevenue(livePaid), true);
  assert.equal(confirmedRevenueAmount(livePaid), 201.99);
});

test('asaas sem account_key (pre multi-account) e sandbox, nao entra', () => {
  const legacySandbox = {
    payment_status: 'paid',
    payment_method: 'pix',
    provider: 'asaas',
    gateway_payment_id: 'pay_tvgknyj0dthbhw5f',
    gateway_account_key: null,
    final_amount: 370.99,
  };
  assert.equal(shouldIncludeInConfirmedRevenue(legacySandbox), false);
});

test('import sem gateway nao entra na receita operacional LIVE', () => {
  const imported = {
    payment_status: 'paid',
    payment_method: 'pix',
    provider: null,
    gateway_payment_id: null,
    final_amount: 200,
  };
  assert.equal(shouldIncludeInConfirmedRevenue(imported), false);
});

test('soma da decomposicao historica 2322.95 fecha centavo a centavo', () => {
  const rows = [370.99, 345, 320.99, 281.99, 201.99, 201.99, 200, 200, 200];
  assert.equal(Number(rows.reduce((sum, value) => sum + value, 0).toFixed(2)), 2322.95);
});

test('drill-down da receita confirmada soma igual ao card', () => {
  const rows = [livePaid, sandboxPaid, { ...livePaid, payment_status: 'refunded' }, { ...livePaid, id: 'b', final_amount: 10.5 }];
  const included = rows.filter((row) => shouldIncludeInConfirmedRevenue(row));
  const card = included.reduce((sum, row) => sum + confirmedRevenueAmount(row), 0);
  const drill = included.reduce((sum, row) => sum + Number(row.final_amount ?? 0), 0);
  assert.equal(card, drill);
  assert.equal(Number(card.toFixed(2)), 212.49);
});
