import assert from 'node:assert/strict';
import test from 'node:test';
import { describeAffected, mapDetectorCheckRow } from '../src/lib/integrity/checks.ts';

test('describeAffected usa o substantivo certo por entity_type e concorda plural/singular', () => {
  assert.equal(describeAffected('ticket', 1), '1 ingresso afetado');
  assert.equal(describeAffected('ticket', 4), '4 ingressos afetados');
  assert.equal(describeAffected('order_item', 2), '2 pedidos afetados');
  assert.equal(describeAffected('registration_contact', 1), '1 cadastro afetado');
  assert.equal(describeAffected('shirt_inventory', 3), '3 itens de estoque afetados');
  assert.equal(describeAffected('event', 2), '2 eventos afetados');
});

test('describeAffected cai no genérico "registros" para entity_type desconhecido ou nulo', () => {
  assert.equal(describeAffected(null, 1), '1 registro afetado');
  assert.equal(describeAffected('unmapped_type', 5), '5 registros afetados');
});

test('mapDetectorCheckRow converte a linha crua da RPC para o contrato tipado', () => {
  const mapped = mapDetectorCheckRow({ code: 'DUPLICATE_ACTIVE_HOLDER', domain: 'titularidade', label: 'Nenhum titular duplicado no mesmo evento' });
  assert.deepEqual(mapped, { code: 'DUPLICATE_ACTIVE_HOLDER', domain: 'titularidade', label: 'Nenhum titular duplicado no mesmo evento' });
});
