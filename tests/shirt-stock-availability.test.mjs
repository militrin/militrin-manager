import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { resolveShirtStockAvailability } = await import('../src/lib/inventory/availability.ts');
const { freeToReserveQuantity, shirtDeficitQuantity } = await import('../src/lib/dashboard/operational-shirt-demand.ts');

test('caso A: 70 total, 1 reservada, 0 entregue → físico 70 / livre 69', () => {
  assert.deepEqual(resolveShirtStockAvailability({ totalQuantity: 70, reservedQuantity: 1, deliveredQuantity: 0 }), {
    physicalAvailable: 70,
    availableForReservation: 69,
    toOrderQuantity: 0,
    overbooked: false,
  });
});

test('caso B: 70 total, 0 reservada, 1 entregue → físico 69 / livre 69', () => {
  assert.deepEqual(resolveShirtStockAvailability({ totalQuantity: 70, reservedQuantity: 0, deliveredQuantity: 1 }), {
    physicalAvailable: 69,
    availableForReservation: 69,
    toOrderQuantity: 0,
    overbooked: false,
  });
});

test('caso C: 70 total, 20 reservadas, 10 entregues → físico 60 / livre 40', () => {
  assert.deepEqual(resolveShirtStockAvailability({ totalQuantity: 70, reservedQuantity: 20, deliveredQuantity: 10 }), {
    physicalAvailable: 60,
    availableForReservation: 40,
    toOrderQuantity: 0,
    overbooked: false,
  });
});

test('caso D: 70 total, 60 reservadas, 10 entregues → físico 60 / livre 0', () => {
  assert.deepEqual(resolveShirtStockAvailability({ totalQuantity: 70, reservedQuantity: 60, deliveredQuantity: 10 }), {
    physicalAvailable: 60,
    availableForReservation: 0,
    toOrderQuantity: 0,
    overbooked: false,
  });
});

test('caso E: reserva maior que físico → livre negativo e falta encomendar, sem truncar em zero', () => {
  assert.deepEqual(resolveShirtStockAvailability({ totalQuantity: 70, reservedQuantity: 80, deliveredQuantity: 10 }), {
    physicalAvailable: 60,
    availableForReservation: -20,
    toOrderQuantity: 20,
    overbooked: true,
  });
});

test('QA: estoque 10 / reserva 8 => livre 2 / encomendar 0', () => {
  assert.equal(freeToReserveQuantity(10, 0, 8), 2);
  assert.equal(shirtDeficitQuantity(10, 0, 8), 0);
});

test('QA: estoque 10 / reserva 10 => livre 0 / encomendar 0', () => {
  assert.equal(freeToReserveQuantity(10, 0, 10), 0);
  assert.equal(shirtDeficitQuantity(10, 0, 10), 0);
});

test('QA: estoque 10 / reserva 11 => livre -1 / encomendar 1', () => {
  assert.equal(freeToReserveQuantity(10, 0, 11), -1);
  assert.equal(shirtDeficitQuantity(10, 0, 11), 1);
});

test('QA: estoque 10 / reserva 15 => livre -5 / encomendar 5', () => {
  assert.equal(freeToReserveQuantity(10, 0, 15), -5);
  assert.equal(shirtDeficitQuantity(10, 0, 15), 5);
});

test('posição atual Militrin: 4 variantes a encomendar somam 8; saldo líquido não zera a falta', () => {
  const rows = [
    { type: 'Camiseta', size: 'PP', received: 4, reserved: 3 },
    { type: 'Camiseta', size: 'P', received: 40, reserved: 32 },
    { type: 'Camiseta', size: 'M', received: 140, reserved: 127 },
    { type: 'Camiseta', size: 'G', received: 140, reserved: 128 },
    { type: 'Camiseta', size: 'GG', received: 70, reserved: 54 },
    { type: 'Camiseta', size: 'EG', received: 10, reserved: 11 },
    { type: 'Camiseta', size: 'EXG', received: 4, reserved: 4 },
    { type: 'Camiseta', size: 'EXGG', received: 3, reserved: 1 },
    { type: 'Babylook', size: 'PP', received: 5, reserved: 4 },
    { type: 'Babylook', size: 'P', received: 25, reserved: 26 },
    { type: 'Babylook', size: 'M', received: 70, reserved: 75 },
    { type: 'Babylook', size: 'G', received: 70, reserved: 55 },
    { type: 'Babylook', size: 'GG', received: 25, reserved: 22 },
    { type: 'Babylook', size: 'EG', received: 3, reserved: 4 },
    { type: 'Babylook', size: 'EXG', received: 1, reserved: 0 },
    { type: 'Babylook', size: 'EXGG', received: 2, reserved: 2 },
  ];
  const withBalance = rows.map((row) => ({
    ...row,
    free: freeToReserveQuantity(row.received, 0, row.reserved),
    toOrder: shirtDeficitQuantity(row.received, 0, row.reserved),
  }));
  assert.deepEqual(
    withBalance.filter((row) => row.toOrder > 0).map((row) => `${row.type} ${row.size}:${row.free}/${row.toOrder}`),
    ['Camiseta EG:-1/1', 'Babylook P:-1/1', 'Babylook M:-5/5', 'Babylook EG:-1/1'],
  );
  assert.equal(withBalance.reduce((sum, row) => sum + row.toOrder, 0), 8);
  assert.equal(withBalance.reduce((sum, row) => sum + row.free, 0), 64);
  assert.equal(withBalance.reduce((sum, row) => sum + row.received, 0) - withBalance.reduce((sum, row) => sum + row.reserved, 0), 64);
});

test('não desconta reserva e entrega duas vezes no físico', () => {
  const result = resolveShirtStockAvailability({ totalQuantity: 70, reservedQuantity: 1, deliveredQuantity: 0 });
  assert.equal(result.physicalAvailable, 70);
  assert.notEqual(result.physicalAvailable, 69);
});

test('modo sob encomenda continua aceitando escolha com saldo <= 0; somente estoque continua limitando', async () => {
  const [wizard, emitir, account, table] = await Promise.all([
    readFile(new URL('../src/app/inscricao/[eventSlug]/wizard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/ingressos/emitir/actions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/mvp/ShirtStockTable.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(wizard, /if \(!enforcePhysicalStock\) return true;/);
  assert.match(wizard, /return available > 0 \|\| isCurrentSelection;/);
  assert.match(emitir, /!limitToStock \|\| variant\.available_quantity > 0/);
  assert.match(account, /disabled: requireStockForChoice && physicallyAvailable <= 0/);
  assert.match(table, /Falta encomendar/);
  assert.match(table, /Livre para<br \/>reservar/);
  assert.doesNotMatch(table, /Overbooking/);
  assert.doesNotMatch(table, /Esgotado/);
});
