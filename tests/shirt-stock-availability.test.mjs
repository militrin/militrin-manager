import test from 'node:test';
import assert from 'node:assert/strict';
const { resolveShirtStockAvailability } = await import('../src/lib/inventory/availability.ts');

test('caso A: 70 total, 1 reservada, 0 entregue → físico 70 / livre 69', () => {
  assert.deepEqual(resolveShirtStockAvailability({ totalQuantity: 70, reservedQuantity: 1, deliveredQuantity: 0 }), {
    physicalAvailable: 70,
    availableForReservation: 69,
    overbooked: false,
  });
});

test('caso B: 70 total, 0 reservada, 1 entregue → físico 69 / livre 69', () => {
  assert.deepEqual(resolveShirtStockAvailability({ totalQuantity: 70, reservedQuantity: 0, deliveredQuantity: 1 }), {
    physicalAvailable: 69,
    availableForReservation: 69,
    overbooked: false,
  });
});

test('caso C: 70 total, 20 reservadas, 10 entregues → físico 60 / livre 40', () => {
  assert.deepEqual(resolveShirtStockAvailability({ totalQuantity: 70, reservedQuantity: 20, deliveredQuantity: 10 }), {
    physicalAvailable: 60,
    availableForReservation: 40,
    overbooked: false,
  });
});

test('caso D: 70 total, 60 reservadas, 10 entregues → físico 60 / livre 0', () => {
  assert.deepEqual(resolveShirtStockAvailability({ totalQuantity: 70, reservedQuantity: 60, deliveredQuantity: 10 }), {
    physicalAvailable: 60,
    availableForReservation: 0,
    overbooked: false,
  });
});

test('caso E: reserva maior que físico → livre 0 + overbooking, nunca negativo', () => {
  assert.deepEqual(resolveShirtStockAvailability({ totalQuantity: 70, reservedQuantity: 80, deliveredQuantity: 10 }), {
    physicalAvailable: 60,
    availableForReservation: 0,
    overbooked: true,
  });
});

test('não desconta reserva e entrega duas vezes no físico', () => {
  const result = resolveShirtStockAvailability({ totalQuantity: 70, reservedQuantity: 1, deliveredQuantity: 0 });
  assert.equal(result.physicalAvailable, 70);
  assert.notEqual(result.physicalAvailable, 69);
});
