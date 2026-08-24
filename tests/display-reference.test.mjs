import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatDisplayNumber,
  isTechnicalIdentifier,
  legacyOrderDisplayNumber,
  orderDisplayReference,
  ticketDisplayReference,
} from '../src/lib/display-reference.ts';

test('formats a stable six-digit public order number', () => {
  assert.equal(formatDisplayNumber(1065), '#001065');
  assert.equal(orderDisplayReference(1066, 'ADMIN-20260824-ec73999e'), '#001066');
});

test('keeps legacy registration orders friendly without exposing MIL prefix', () => {
  assert.equal(legacyOrderDisplayNumber('MIL-2026-00001065'), '#001065');
  assert.equal(orderDisplayReference(null, 'MIL-2026-00001065'), '#001065');
});

test('never uses a technical grant number as visual fallback', () => {
  assert.equal(orderDisplayReference(null, 'ADMIN-20260824-ec73999e'), 'sem número');
  assert.equal(ticketDisplayReference(1065, 2), '#001065-02');
});

test('detects UUIDs and internal prefixes', () => {
  assert.equal(isTechnicalIdentifier('e3ac98a0-c179-4d1d-ac06-1aa2db7f367d'), true);
  assert.equal(isTechnicalIdentifier('ADMIN-20260824-ec73999e'), true);
  assert.equal(isTechnicalIdentifier('ITEM-42E08C95EA32'), true);
  assert.equal(isTechnicalIdentifier('#001065'), false);
});
