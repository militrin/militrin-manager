import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeHistoryCursor, paginateByCursor } from '../src/lib/operations/history/paginate.ts';
import { pickDefaultEvent, resolveHistoryPeriod } from '../src/lib/operations/history/period.ts';
import { PAGE_SIZE } from '../src/lib/operations/history/constants.ts';

test('paginação por cursor devolve ~50 e o restante no Carregar mais', () => {
  const items = Array.from({ length: 120 }, (_, index) => ({
    id: `id-${String(index).padStart(3, '0')}`,
    occurredAt: new Date(Date.parse('2026-09-24T17:00:00.000Z') + (120 - index) * 1000).toISOString(),
  }));
  const first = paginateByCursor(items, null, PAGE_SIZE);
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  assert.equal(first.items[0].id, items.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))[0].id);

  const second = paginateByCursor(items, first.nextCursor, PAGE_SIZE);
  assert.equal(second.items.length, 50);
  assert.ok(second.nextCursor);
  const overlap = new Set(first.items.map((item) => item.id));
  assert.equal(second.items.some((item) => overlap.has(item.id)), false);

  const third = paginateByCursor(items, second.nextCursor, PAGE_SIZE);
  assert.equal(third.items.length, 20);
  assert.equal(third.nextCursor, null);
});

test('cursor inválido não quebra a primeira página', () => {
  const items = [{ id: 'a', occurredAt: '2026-09-24T17:00:00.000Z' }];
  const page = paginateByCursor(items, 'not-a-cursor', 50);
  assert.equal(page.items.length, 1);
});

test('período Hoje usa o calendário do evento, 7 e 30 dias são inclusivos até hoje', () => {
  const now = new Date('2026-09-24T18:30:00-03:00');
  assert.deepEqual(resolveHistoryPeriod({ period: 'today', now }), { dateFrom: '2026-09-24', dateTo: '2026-09-24' });
  assert.deepEqual(resolveHistoryPeriod({ period: '7d', now }), { dateFrom: '2026-09-18', dateTo: '2026-09-24' });
  assert.deepEqual(resolveHistoryPeriod({ period: '30d', now }), { dateFrom: '2026-08-26', dateTo: '2026-09-24' });
  assert.deepEqual(
    resolveHistoryPeriod({ period: 'custom', dateFrom: '2026-09-01', dateTo: '2026-09-10', now }),
    { dateFrom: '2026-09-01', dateTo: '2026-09-10' },
  );
});

test('evento padrão é o atual; senão o mais recente', () => {
  const now = new Date('2026-09-24T18:00:00Z');
  const events = [
    { id: 'future', name: 'Futuro', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-10-02T00:00:00Z' },
    { id: 'live', name: 'Agora', starts_at: '2026-09-24T12:00:00Z', ends_at: '2026-09-24T23:00:00Z' },
    { id: 'past', name: 'Passado', starts_at: '2026-08-01T00:00:00Z', ends_at: '2026-08-02T00:00:00Z' },
  ];
  assert.equal(pickDefaultEvent(events, now)?.id, 'live');
  assert.equal(pickDefaultEvent([events[0], events[2]], now)?.id, 'future');
});

test('encode/decode de cursor é estável', () => {
  const cursor = encodeHistoryCursor({ occurredAt: '2026-09-24T17:32:17.123Z', id: 'audit-abc' });
  const page = paginateByCursor([
    { id: 'audit-abc', occurredAt: '2026-09-24T17:32:17.123Z' },
    { id: 'older', occurredAt: '2026-09-24T17:00:00.000Z' },
  ], cursor, 50);
  assert.deepEqual(page.items.map((item) => item.id), ['older']);
});
