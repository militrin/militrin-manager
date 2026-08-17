import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeIntegrityReport, mapReportRow } from '../src/lib/integrity/report.ts';

function issue(overrides = {}) {
  return {
    code: 'X', severity: 'critical', domain: 'titularidade', title: 't', description: 'd',
    eventId: null, affectedCount: 1, actionLabel: null, actionHref: null,
    sampleEntityType: null, sampleEntityId: null,
    ...overrides,
  };
}

test('conta cada severidade separadamente', () => {
  const totals = summarizeIntegrityReport([
    issue({ code: 'A', severity: 'critical' }),
    issue({ code: 'B', severity: 'attention' }),
    issue({ code: 'C', severity: 'attention' }),
    issue({ code: 'D', severity: 'warning' }),
  ], 10);
  assert.equal(totals.critical, 1);
  assert.equal(totals.attention, 2);
  assert.equal(totals.warning, 1);
});

test('ok = total de detectores menos códigos distintos com problema (nunca conta o mesmo code duas vezes por causa de 2 eventos)', () => {
  const totals = summarizeIntegrityReport([
    issue({ code: 'A', severity: 'critical', eventId: 'evt-1' }),
    issue({ code: 'A', severity: 'critical', eventId: 'evt-2' }),
  ], 14);
  assert.equal(totals.ok, 13, 'o mesmo code em 2 eventos ainda conta como 1 verificacao reprovada, nao 2');
});

test('estado saudável: nenhum problema, todas as verificações aprovadas', () => {
  const totals = summarizeIntegrityReport([], 14);
  assert.deepEqual(totals, { critical: 0, attention: 0, warning: 0, ok: 14 });
});

test('ok nunca fica negativo mesmo com mais ocorrências que detectores', () => {
  const totals = summarizeIntegrityReport([issue({ code: 'A' }), issue({ code: 'B' }), issue({ code: 'C' })], 2);
  assert.equal(totals.ok, 0);
});

test('mapReportRow converte a linha crua da RPC para o contrato tipado', () => {
  const mapped = mapReportRow({
    code: 'DUPLICATE_ACTIVE_HOLDER', severity: 'critical', domain: 'titularidade',
    title: 'Titular duplicado', description: 'desc', event_id: 'evt-1', affected_count: 2,
    action_label: 'Abrir ingresso', action_href: '/ingressos/123', sample_entity_type: 'ticket', sample_entity_id: '123',
  });
  assert.deepEqual(mapped, {
    code: 'DUPLICATE_ACTIVE_HOLDER', severity: 'critical', domain: 'titularidade',
    title: 'Titular duplicado', description: 'desc', eventId: 'evt-1', affectedCount: 2,
    actionLabel: 'Abrir ingresso', actionHref: '/ingressos/123', sampleEntityType: 'ticket', sampleEntityId: '123',
  });
});

test('mapReportRow trata event_id/action nulos corretamente', () => {
  const mapped = mapReportRow({
    code: 'X', severity: 'warning', domain: 'd', title: 't', description: 'd', event_id: null,
    affected_count: 1, action_label: null, action_href: null, sample_entity_type: null, sample_entity_id: null,
  });
  assert.equal(mapped.eventId, null);
  assert.equal(mapped.actionLabel, null);
});
