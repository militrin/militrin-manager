import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDisplayNumber,
  isTechnicalIdentifier,
  legacyOrderDisplayNumber,
  orderDisplayReference,
  publicOrderCode,
  parseStoredMilOrderNumber,
  ticketDisplayReference,
  canonicalTicketDisplayCode,
  parseTicketDisplayCode,
  ticketMatchesExactDisplayCode,
} from '../src/lib/display-reference.ts';

test('formats a stable six-digit public order number for non-MIL records', () => {
  assert.equal(formatDisplayNumber(1065), '#001065');
  assert.equal(orderDisplayReference(1066, 'ADMIN-20260824-ec73999e'), '#001066');
});

test('codigo publico do pedido reusa orders.order_number MIL-YYYY-XXXXXXXX', () => {
  assert.equal(legacyOrderDisplayNumber('MIL-2026-00001065'), '#001065');
  assert.equal(publicOrderCode(1827, 'MIL-2026-00001827'), 'MIL-2026-00001827');
  assert.equal(orderDisplayReference(1827, 'MIL-2026-00001827'), 'MIL-2026-00001827');
  assert.equal(orderDisplayReference(null, 'MIL-2026-00001065'), 'MIL-2026-00001065');
  assert.equal(publicOrderCode(null, 'MIL-2026-1827'), 'MIL-2026-00001827');
  assert.deepEqual(parseStoredMilOrderNumber('MIL-2026-00001827'), {
    year: '2026',
    sequence: 1827,
    canonical: 'MIL-2026-00001827',
  });
});

test('never uses a technical grant number as visual fallback', () => {
  assert.equal(orderDisplayReference(null, 'ADMIN-20260824-ec73999e'), 'sem número');
  assert.equal(ticketDisplayReference(1065, 2), '#001065-02');
});

test('detects UUIDs and internal prefixes, but MIL de pedido e publico', () => {
  assert.equal(isTechnicalIdentifier('e3ac98a0-c179-4d1d-ac06-1aa2db7f367d'), true);
  assert.equal(isTechnicalIdentifier('ADMIN-20260824-ec73999e'), true);
  assert.equal(isTechnicalIdentifier('ITEM-42E08C95EA32'), true);
  assert.equal(isTechnicalIdentifier('#001065'), false);
  assert.equal(isTechnicalIdentifier('MIL-2026-00001827'), false);
});

test('pedido com 3 ingressos gera tres codigos distintos', () => {
  const codes = [1, 2, 3].map((position) => ticketDisplayReference(1065, position));
  assert.deepEqual(codes, ['#001065-01', '#001065-02', '#001065-03']);
  assert.equal(new Set(codes).size, 3);
});

test('parse do codigo completo ignora hash, espacos e zeros a esquerda', () => {
  assert.deepEqual(parseTicketDisplayCode('#001065-02'), { displayNumber: 1065, itemPosition: 2 });
  assert.deepEqual(parseTicketDisplayCode('001065-02'), { displayNumber: 1065, itemPosition: 2 });
  assert.deepEqual(parseTicketDisplayCode('  #1065 - 2  '), { displayNumber: 1065, itemPosition: 2 });
  assert.equal(parseTicketDisplayCode('#001065'), null);
  assert.equal(parseTicketDisplayCode('001065'), null);
  assert.equal(canonicalTicketDisplayCode(1065, null), null);
});

test('busca pelo codigo completo resolve exatamente um ingresso', () => {
  const tickets = [
    { id: 'A', code: ticketDisplayReference(1065, 1) },
    { id: 'B', code: ticketDisplayReference(1065, 2) },
    { id: 'C', code: ticketDisplayReference(1065, 3) },
  ];
  const matchedHash = tickets.filter((ticket) => ticketMatchesExactDisplayCode('#001065-02', ticket.code));
  const matchedPlain = tickets.filter((ticket) => ticketMatchesExactDisplayCode('001065-02', ticket.code));
  assert.deepEqual(matchedHash.map((ticket) => ticket.id), ['B']);
  assert.deepEqual(matchedPlain.map((ticket) => ticket.id), ['B']);
  assert.equal(ticketMatchesExactDisplayCode('João', tickets[1].code), null);
});
