import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extraHistoryFilterCount,
  feedIconKind,
  feedMetaLine,
  feedParticipantLine,
  feedTone,
  formatFeedOccurredAt,
  formatHistoryPeriodLabel,
} from '../src/lib/operations/history/presentation.ts';

const baseItem = {
  title: 'KIT ENTREGUE + CHECK-IN',
  category: 'kit',
  counts: { kit: true, checkin: true, wristband: false, correction: false, manualIssue: false },
  participantName: 'Julia Kollmann Weis',
  ticketCode: '#002022-01',
  shirtLabel: 'Babylook M',
  wristbandLabel: null,
  operatorName: 'Douglas Hobold',
  stateChanges: [],
};

test('no período Hoje e Ontem o feed mostra só HH:mm', () => {
  const now = new Date('2026-09-25T18:00:00-03:00');
  assert.equal(formatFeedOccurredAt('2026-09-25T16:13:00.000Z', 'today', now), '13:13');
  assert.equal(formatFeedOccurredAt('2026-09-24T21:42:00.000Z', 'yesterday', now), '18:42');
});

test('períodos maiores usam Hoje, Ontem e dd/MM', () => {
  const now = new Date('2026-09-25T18:00:00-03:00');
  assert.equal(formatFeedOccurredAt('2026-09-25T16:13:00.000Z', '7d', now), 'Hoje 13:13');
  assert.equal(formatFeedOccurredAt('2026-09-24T21:42:00.000Z', '7d', now), 'Ontem 18:42');
  assert.equal(formatFeedOccurredAt('2026-09-23T17:20:00.000Z', '30d', now), '23/09 14:20');
});

test('filtros extras não contam busca nem o período Hoje', () => {
  assert.equal(extraHistoryFilterCount({ period: 'today', category: 'all', operatorUserId: '' }), 0);
  assert.equal(extraHistoryFilterCount({ period: '7d', category: 'kit', operatorUserId: 'abc' }), 3);
  assert.equal(extraHistoryFilterCount({ period: 'yesterday', category: 'kit', operatorUserId: '', shirtType: 'Camiseta', shirtSize: 'EXGG' }), 4);
  assert.match(formatHistoryPeriodLabel({ period: 'today', dateFrom: '2026-09-27', dateTo: '2026-09-27' }), /Hoje · 27\/09\/2026 · America\/Sao_Paulo/);
});

test('linha de meta do feed junta ingresso, info e operador sem prefixo', () => {
  assert.equal(feedMetaLine(baseItem), '#002022-01 · Babylook M · Douglas Hobold');
  assert.equal(feedParticipantLine(baseItem), 'Julia Kollmann Weis');
  assert.doesNotMatch(feedMetaLine(baseItem), /Operador:/);
});

test('pulseira usa o código mascarado na meta, sem a palavra Pulseira', () => {
  const item = { ...baseItem, title: 'PULSEIRA VINCULADA', category: 'wristbands', shirtLabel: null, wristbandLabel: '••••8596', counts: { kit: false, checkin: false, wristband: true, correction: false, manualIssue: false } };
  assert.equal(feedMetaLine(item), '#002022-01 · ••••8596 · Douglas Hobold');
  assert.equal(feedTone(item), 'success');
  assert.equal(feedIconKind(item), 'wristband');
});

test('undo e alteração usam tons discretos', () => {
  assert.equal(feedTone({ title: 'ENTREGA DE KIT DESFEITA', counts: { kit: false, checkin: false, wristband: false, correction: true, manualIssue: false } }), 'danger');
  assert.equal(feedIconKind({ title: 'ENTREGA DE KIT DESFEITA', category: 'kit', counts: { kit: false, checkin: false, wristband: false, correction: true, manualIssue: false } }), 'undo');
  assert.equal(feedTone({ title: 'PULSEIRA SUBSTITUÍDA', counts: { kit: false, checkin: false, wristband: true, correction: false, manualIssue: false } }), 'warning');
  assert.equal(feedTone({ title: 'KIT ENTREGUE', counts: { kit: true, checkin: false, wristband: false, correction: false, manualIssue: false } }), 'success');
});
