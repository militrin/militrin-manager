process.env.TZ = 'UTC';

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  datetimeLocalInEventTimeZoneToIso,
  formatDateTimeBR,
  toDatetimeLocalValue,
} from '../src/lib/utils/date.ts';
import { formatEventPassDate } from '../src/components/ticket-pass/ticket-pass-format.ts';

test('datetime-local 16:00 em America/Sao_Paulo grava 19:00Z, sem offset hardcoded', () => {
  assert.equal(datetimeLocalInEventTimeZoneToIso('2026-10-10T16:00'), '2026-10-10T19:00:00.000Z');
  assert.equal(process.env.TZ, 'UTC');
});

test('instante já gravado com offset não é reinterpretado como parede', () => {
  assert.equal(datetimeLocalInEventTimeZoneToIso('2026-10-10T19:00:00.000Z'), '2026-10-10T19:00:00.000Z');
  assert.equal(datetimeLocalInEventTimeZoneToIso('2026-10-10T16:00:00-03:00'), '2026-10-10T19:00:00.000Z');
});

test('evento 16:00 America/Sao_Paulo aparece 16:00 na serialização de tela, admin e ingresso', () => {
  const stored = '2026-10-10T19:00:00.000Z';
  assert.equal(formatDateTimeBR(stored), '10/10/2026 16:00');
  assert.equal(toDatetimeLocalValue(stored), '2026-10-10T16:00');
  assert.equal(formatEventPassDate(stored)?.time, '16:00');
});

test('16:00 UTC (caso Militrin atual) mostra 13:00 em todas as telas SP, sem +3h no código', () => {
  const stored = '2026-10-10T16:00:00.000Z';
  assert.equal(formatDateTimeBR(stored), '10/10/2026 13:00');
  assert.equal(toDatetimeLocalValue(stored), '2026-10-10T13:00');
  assert.equal(formatEventPassDate(stored)?.time, '13:00');
});
