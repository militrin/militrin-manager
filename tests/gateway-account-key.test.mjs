import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseCurrentGatewayForCharge, getPaymentGatewayAccountKey } from '../src/lib/payments/gateway-account-key.ts';

test('rotulo vazio ou ausente e origem desconhecida: nao opera na conta ativa', () => {
  const previous = process.env.ASAAS_ACCOUNT_KEY;
  process.env.ASAAS_ACCOUNT_KEY = 'militrin-oficial';
  try {
    assert.equal(canUseCurrentGatewayForCharge(null), false);
    assert.equal(canUseCurrentGatewayForCharge(''), false);
    assert.equal(canUseCurrentGatewayForCharge('   '), false);
  } finally {
    if (previous === undefined) delete process.env.ASAAS_ACCOUNT_KEY;
    else process.env.ASAAS_ACCOUNT_KEY = previous;
  }
});

test('rotulo diferente da conta ativa nao e reutilizado', () => {
  const previous = process.env.ASAAS_ACCOUNT_KEY;
  process.env.ASAAS_ACCOUNT_KEY = 'militrin-oficial';
  try {
    assert.equal(canUseCurrentGatewayForCharge('militrin-temp'), false);
    assert.equal(canUseCurrentGatewayForCharge('militrin-oficial'), true);
  } finally {
    if (previous === undefined) delete process.env.ASAAS_ACCOUNT_KEY;
    else process.env.ASAAS_ACCOUNT_KEY = previous;
  }
});

test('sem ASAAS_ACCOUNT_KEY ativa, nenhuma cobranca persistida e operavel na API atual', () => {
  const previous = process.env.ASAAS_ACCOUNT_KEY;
  delete process.env.ASAAS_ACCOUNT_KEY;
  try {
    assert.equal(getPaymentGatewayAccountKey(), null);
    assert.equal(canUseCurrentGatewayForCharge('militrin-temp'), false);
  } finally {
    if (previous === undefined) delete process.env.ASAAS_ACCOUNT_KEY;
    else process.env.ASAAS_ACCOUNT_KEY = previous;
  }
});
