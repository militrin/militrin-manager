import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function read(rel) {
  return readFile(new URL(rel, import.meta.url), 'utf8');
}

test('rota 2295 usa fluxo de cartao, nao o worker PIX', async () => {
  const route = await read('../src/app/api/internal/cancel-stale-card-charges/route.ts');
  const lib = await read('../src/lib/payments/cancel-card-installment-charges.ts');
  const vercel = await read('../vercel.json');
  assert.match(route, /CRON_SECRET/);
  assert.match(route, /cancelCardInstallmentCharges/);
  assert.doesNotMatch(route, /expireAndCancelStalePixPayments/);
  assert.match(lib, /list_live_gateway_charge_ids/);
  assert.match(lib, /cancelPayment/);
  assert.match(lib, /getPayment/);
  assert.match(lib, /mark_gateway_charges_not_reusable/);
  assert.match(lib, /getPaymentGatewayProviderForMethod\("credit_card"\)/);
  assert.doesNotMatch(lib, /listedSet\.has\(row\.providerPaymentId\)/);
  assert.doesNotMatch(lib, /expireAndCancelStalePixPayments/);
  assert.doesNotMatch(lib, /complete_expired_pix_cancellation/);
  assert.match(vercel, /\/api\/internal\/expire-payments/);
});
