import test from 'node:test';
import assert from 'node:assert/strict';
import { kitItemStatusLabel } from '../src/lib/checkout/kit-item-status.ts';

test('reserved e confirmed viram "A retirar" (item ainda nao entregue fisicamente)', () => {
  assert.equal(kitItemStatusLabel('reserved'), 'A retirar');
  assert.equal(kitItemStatusLabel('confirmed'), 'A retirar');
});

test('delivered vira "Entregue"', () => {
  assert.equal(kitItemStatusLabel('delivered'), 'Entregue');
});
