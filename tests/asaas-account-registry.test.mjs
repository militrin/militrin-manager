import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAsaasAccountCredentialsForMethod,
  getAsaasAccountCredentialsForAccountKey,
  isConfiguredGatewayAccountKey,
  listConfiguredAsaasAccounts,
  resolveAsaasWebhookAccountKey,
} from '../src/lib/payments/asaas-account-registry.ts';

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

test('trio legado serve PIX e cartao na mesma account_key', () => {
  withEnv({
    ASAAS_API_KEY: 'legacy-api',
    ASAAS_ACCOUNT_KEY: 'asaas-sandbox-militrin',
    ASAAS_WEBHOOK_TOKEN: 'legacy-token',
    ASAAS_PIX_API_KEY: undefined,
    ASAAS_PIX_ACCOUNT_KEY: undefined,
    ASAAS_PIX_WEBHOOK_TOKEN: undefined,
    ASAAS_CARD_API_KEY: undefined,
    ASAAS_CARD_ACCOUNT_KEY: undefined,
    ASAAS_CARD_WEBHOOK_TOKEN: undefined,
  }, () => {
    const accounts = listConfiguredAsaasAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].accountKey, 'asaas-sandbox-militrin');
    assert.deepEqual(accounts[0].methods.sort(), ['credit_card', 'pix']);
    assert.equal(getAsaasAccountCredentialsForMethod('pix')?.accountKey, 'asaas-sandbox-militrin');
    assert.equal(getAsaasAccountCredentialsForMethod('credit_card')?.accountKey, 'asaas-sandbox-militrin');
  });
});

test('PIX e cartao em contas distintas nao compartilham credencial', () => {
  withEnv({
    ASAAS_PIX_API_KEY: 'pix-api',
    ASAAS_PIX_ACCOUNT_KEY: 'conta-pix',
    ASAAS_PIX_WEBHOOK_TOKEN: 'pix-token',
    ASAAS_CARD_API_KEY: 'card-api',
    ASAAS_CARD_ACCOUNT_KEY: 'conta-card',
    ASAAS_CARD_WEBHOOK_TOKEN: 'card-token',
    ASAAS_ACCOUNT_KEY: 'asaas-sandbox-militrin',
    ASAAS_API_KEY: 'legacy-api',
    ASAAS_WEBHOOK_TOKEN: 'legacy-token',
  }, () => {
    const accounts = listConfiguredAsaasAccounts();
    assert.equal(accounts.length, 3);
    assert.equal(getAsaasAccountCredentialsForMethod('pix')?.apiKey, 'pix-api');
    assert.equal(getAsaasAccountCredentialsForMethod('credit_card')?.apiKey, 'card-api');
    assert.equal(accounts.some((account) => account.accountKey === 'asaas-sandbox-militrin'), true);
  });
});

test('mesma account_key com API keys diferentes e erro de configuracao', () => {
  withEnv({
    ASAAS_PIX_API_KEY: 'pix-api',
    ASAAS_PIX_ACCOUNT_KEY: 'mesma-conta',
    ASAAS_PIX_WEBHOOK_TOKEN: 'pix-token',
    ASAAS_CARD_API_KEY: 'outra-api',
    ASAAS_CARD_ACCOUNT_KEY: 'mesma-conta',
    ASAAS_CARD_WEBHOOK_TOKEN: 'card-token',
  }, () => {
    assert.throws(() => listConfiguredAsaasAccounts(), /API keys diferentes/);
  });
});

test('token de webhook identifica a conta; token errado nao resolve', () => {
  withEnv({
    ASAAS_PIX_API_KEY: 'pix-api',
    ASAAS_PIX_ACCOUNT_KEY: 'conta-pix',
    ASAAS_PIX_WEBHOOK_TOKEN: 'pix-token',
    ASAAS_CARD_API_KEY: 'card-api',
    ASAAS_CARD_ACCOUNT_KEY: 'conta-card',
    ASAAS_CARD_WEBHOOK_TOKEN: 'card-token',
    ASAAS_ACCOUNT_KEY: undefined,
    ASAAS_API_KEY: undefined,
    ASAAS_WEBHOOK_TOKEN: undefined,
  }, () => {
    assert.equal(resolveAsaasWebhookAccountKey({ 'asaas-access-token': 'pix-token' }), 'conta-pix');
    assert.equal(resolveAsaasWebhookAccountKey({ 'asaas-access-token': 'card-token' }), 'conta-card');
    assert.equal(resolveAsaasWebhookAccountKey({ 'asaas-access-token': 'errado' }), null);
  });
});

test('rotulo historico desconhecido falha fechado', () => {
  withEnv({
    ASAAS_PIX_API_KEY: 'pix-api',
    ASAAS_PIX_ACCOUNT_KEY: 'conta-pix',
    ASAAS_PIX_WEBHOOK_TOKEN: 'pix-token',
    ASAAS_CARD_API_KEY: undefined,
    ASAAS_CARD_ACCOUNT_KEY: undefined,
    ASAAS_CARD_WEBHOOK_TOKEN: undefined,
    ASAAS_ACCOUNT_KEY: undefined,
    ASAAS_API_KEY: undefined,
    ASAAS_WEBHOOK_TOKEN: undefined,
  }, () => {
    assert.equal(getAsaasAccountCredentialsForAccountKey('conta-inexistente'), null);
    assert.equal(getAsaasAccountCredentialsForAccountKey(''), null);
    assert.equal(isConfiguredGatewayAccountKey('conta-inexistente'), false);
  });
});
