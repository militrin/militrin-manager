import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  publicOrderCode,
  publicOrderChargeDescription,
  parsePublicOrderQuery,
  orderMatchesPublicQuery,
  orderMatchesAdminSearch,
} from '../src/lib/display-reference.ts';
import { orderChargeBreakdown } from '../src/lib/orders/charge-breakdown.ts';

const larissa = {
  displayNumber: 1827,
  orderNumber: 'MIL-2026-00001827',
  publicCode: 'MIL-2026-00001827',
  buyerName: 'Larissa Dors',
  buyerEmail: 'larissa@example.com',
  buyerCpf: '12345678901',
};

test('pedido 1827 vira MIL-2026-00001827 no contexto armazenado', () => {
  assert.equal(publicOrderCode(1827, 'MIL-2026-00001827'), 'MIL-2026-00001827');
  assert.equal(publicOrderChargeDescription('MIL-2026-00001827'), 'Pedido MIL-2026-00001827');
  assert.equal(publicOrderChargeDescription('MIL-2026-1827'), 'Pedido MIL-2026-00001827');
});

test('nao inventa MIL sem ano armazenado', () => {
  assert.equal(publicOrderCode(1827, null), '#001827');
  assert.equal(publicOrderCode(null, 'ADMIN-20260909-abc3bda0'), 'sem número');
  assert.equal(publicOrderCode(1121, 'ADMIN-20260909-abc3bda0'), '#001121');
});

test('busca pelo codigo completo e pelo numero simplificado', () => {
  assert.deepEqual(parsePublicOrderQuery('Pedido MIL-2026-00001827'), {
    kind: 'mil',
    canonical: 'MIL-2026-00001827',
    year: '2026',
    sequence: 1827,
  });
  for (const query of ['MIL-2026-00001827', 'Pedido MIL-2026-00001827', '00001827', '001827', '1827', '#001827']) {
    assert.equal(orderMatchesPublicQuery(query, larissa), true, query);
  }
  assert.equal(orderMatchesPublicQuery('MIL-2025-00001827', larissa), false);
  assert.equal(orderMatchesPublicQuery('1828', larissa), false);
});

test('busca administrativa preserva nome, e-mail e CPF e evita ambiguidade de sequencia', () => {
  assert.equal(orderMatchesAdminSearch('Larissa', larissa), true);
  assert.equal(orderMatchesAdminSearch('larissa@example.com', larissa), true);
  assert.equal(orderMatchesAdminSearch('123.456.789-01', larissa), true);
  assert.equal(orderMatchesAdminSearch('MIL-2026-00001827', larissa), true);
  assert.equal(orderMatchesAdminSearch('1827', { ...larissa, buyerCpf: '18270000000' }), true);
  assert.equal(orderMatchesAdminSearch('1827', {
    displayNumber: 99,
    orderNumber: 'MIL-2026-00000099',
    buyerName: 'Outra pessoa',
    buyerEmail: 'outra@example.com',
    buyerCpf: '18270000000',
  }), false);
});

test('composicao financeira usa valores armazenados, sem percentual hardcoded', () => {
  const withFee = orderChargeBreakdown({ itemsAmount: 175, customerFee: 8.75, chargedAmount: 183.75 });
  assert.deepEqual(withFee, {
    itemsAmount: 175,
    customerFee: 8.75,
    chargedAmount: 183.75,
    hasCustomerFee: true,
  });
  assert.equal(Number((withFee.itemsAmount + withFee.customerFee).toFixed(2)), 183.75);

  const pix = orderChargeBreakdown({ itemsAmount: 175, customerFee: 0, chargedAmount: 175 });
  assert.equal(pix.hasCustomerFee, false);
  assert.equal(pix.chargedAmount, 175);

  const expiredCard = orderChargeBreakdown({ itemsAmount: 175, customerFee: 8.75, chargedAmount: 183.75 });
  assert.equal(expiredCard.chargedAmount, 183.75);

  const paid = orderChargeBreakdown({ itemsAmount: 175, customerFee: 8.75, chargedAmount: 183.75 });
  assert.equal(paid.itemsAmount + paid.customerFee, paid.chargedAmount);
});

test('IDs internos nao sao reformatados pelo codigo publico', () => {
  const orderId = 'e3ac98a0-c179-4d1d-ac06-1aa2db7f367d';
  assert.equal(publicOrderCode(1827, 'MIL-2026-00001827'), 'MIL-2026-00001827');
  assert.notEqual(publicOrderCode(1827, 'MIL-2026-00001827'), orderId);
  assert.notEqual(publicOrderCode(1827, 'MIL-2026-00001827'), '#001827');
});

test('PIX e cartao enviam ao Asaas o mesmo codigo publico exibido', async () => {
  const actions = await readFile(new URL('../src/app/inscricao/actions.ts', import.meta.url), 'utf8');
  assert.match(actions, /publicOrderChargeDescription\(snapshotResult\.snapshot\.order_number\)/);
  assert.equal((actions.match(/publicOrderChargeDescription\(snapshotResult\.snapshot\.order_number\)/g) ?? []).length, 2);
  assert.doesNotMatch(actions, /Pedido \$\{snapshotResult\.snapshot\.order_number\}/);
});
