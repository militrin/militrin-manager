import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseCurrentGatewayForCharge, getPaymentGatewayAccountKey } from '../src/lib/payments/gateway-account-key.ts';

function withEnv(values, run) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const pixTrio = {
  ASAAS_PIX_API_KEY: 'pix-api',
  ASAAS_PIX_ACCOUNT_KEY: 'militrin-oficial',
  ASAAS_PIX_WEBHOOK_TOKEN: 'pix-token',
};

test('rotulo vazio ou ausente e origem desconhecida: nao opera na conta ativa', () => {
  withEnv({ ASAAS_ACCOUNT_KEY: 'militrin-oficial', ASAAS_API_KEY: 'k', ASAAS_WEBHOOK_TOKEN: 't' }, () => {
    assert.equal(canUseCurrentGatewayForCharge(null), false);
    assert.equal(canUseCurrentGatewayForCharge(''), false);
    assert.equal(canUseCurrentGatewayForCharge('   '), false);
  });
});

test('rotulo diferente da conta configurada nao e reutilizado', () => {
  withEnv({
    ASAAS_ACCOUNT_KEY: 'militrin-oficial',
    ASAAS_API_KEY: 'k',
    ASAAS_WEBHOOK_TOKEN: 't',
    ASAAS_PIX_API_KEY: undefined,
    ASAAS_PIX_ACCOUNT_KEY: undefined,
    ASAAS_PIX_WEBHOOK_TOKEN: undefined,
    ASAAS_CARD_API_KEY: undefined,
    ASAAS_CARD_ACCOUNT_KEY: undefined,
    ASAAS_CARD_WEBHOOK_TOKEN: undefined,
  }, () => {
    assert.equal(canUseCurrentGatewayForCharge('militrin-temp'), false);
    assert.equal(canUseCurrentGatewayForCharge('militrin-oficial'), true);
  });
});

test('sem account_key configurada, nenhuma cobranca persistida e operavel na API atual', () => {
  withEnv({
    ASAAS_ACCOUNT_KEY: undefined,
    ASAAS_API_KEY: undefined,
    ASAAS_WEBHOOK_TOKEN: undefined,
    ASAAS_PIX_API_KEY: undefined,
    ASAAS_PIX_ACCOUNT_KEY: undefined,
    ASAAS_PIX_WEBHOOK_TOKEN: undefined,
    ASAAS_CARD_API_KEY: undefined,
    ASAAS_CARD_ACCOUNT_KEY: undefined,
    ASAAS_CARD_WEBHOOK_TOKEN: undefined,
  }, () => {
    assert.equal(getPaymentGatewayAccountKey(), null);
    assert.equal(canUseCurrentGatewayForCharge('militrin-temp'), false);
  });
});

test('PIX e cartao com account_keys distintas sao ambas operaveis', () => {
  withEnv({
    ...pixTrio,
    ASAAS_CARD_API_KEY: 'card-api',
    ASAAS_CARD_ACCOUNT_KEY: 'militrin-card',
    ASAAS_CARD_WEBHOOK_TOKEN: 'card-token',
    ASAAS_ACCOUNT_KEY: undefined,
    ASAAS_API_KEY: undefined,
    ASAAS_WEBHOOK_TOKEN: undefined,
  }, () => {
    assert.equal(canUseCurrentGatewayForCharge('militrin-oficial'), true);
    assert.equal(canUseCurrentGatewayForCharge('militrin-card'), true);
    assert.equal(getPaymentGatewayAccountKey(), 'militrin-oficial');
  });
});
