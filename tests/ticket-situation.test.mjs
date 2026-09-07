import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTicketOperationalSituation,
  eventHasEnded,
  parseTicketSituationFilter,
  partitionTicketsBySituation,
  ticketSituationLabel,
} from '../src/lib/tickets/ticket-situation.ts';

const now = Date.parse('2026-09-07T18:00:00.000Z');

test('evento encerrado usa ends_at quando existe', () => {
  assert.equal(eventHasEnded({ endsAt: '2026-09-07T17:00:00.000Z', startsAt: '2026-09-08T12:00:00.000Z' }, now), true);
  assert.equal(eventHasEnded({ endsAt: '2026-09-07T19:00:00.000Z', startsAt: '2026-09-01T12:00:00.000Z' }, now), false);
});

test('sem ends_at, starts_at e a data canonica de encerramento', () => {
  assert.equal(eventHasEnded({ endsAt: null, startsAt: '2026-09-07T17:00:00.000Z' }, now), true);
  assert.equal(eventHasEnded({ endsAt: null, startsAt: '2026-09-07T19:00:00.000Z' }, now), false);
  assert.equal(eventHasEnded({ endsAt: null, startsAt: null }, now), false);
});

test('somente ingresso ativo + evento futuro/em andamento => ativos', () => {
  assert.equal(classifyTicketOperationalSituation({
    ticketStatus: 'active',
    eventEndsAt: '2026-09-08T03:00:00.000Z',
    eventStartsAt: '2026-09-07T20:00:00.000Z',
    eventIsActive: true,
  }, now), 'ativos');
  assert.equal(classifyTicketOperationalSituation({
    ticketStatus: 'used',
    eventEndsAt: '2026-09-08T03:00:00.000Z',
    eventIsActive: true,
  }, now), 'ativos');
});

test('ticket valido de evento ja terminado => anteriores, mesmo se used', () => {
  assert.equal(classifyTicketOperationalSituation({
    ticketStatus: 'active',
    eventEndsAt: '2026-09-06T03:00:00.000Z',
    eventIsActive: true,
  }, now), 'anteriores');
  assert.equal(classifyTicketOperationalSituation({
    ticketStatus: 'used',
    eventEndsAt: '2026-09-06T03:00:00.000Z',
    eventIsActive: false,
  }, now), 'anteriores');
});

test('ticket cancelado => cancelados, mesmo com evento futuro', () => {
  assert.equal(classifyTicketOperationalSituation({
    ticketStatus: 'cancelled',
    eventEndsAt: '2026-12-01T03:00:00.000Z',
    eventIsActive: true,
  }, now), 'cancelados');
});

test('evento desativado ainda nao encerrado => inativos; nao inventa status de ticket', () => {
  assert.equal(classifyTicketOperationalSituation({
    ticketStatus: 'active',
    eventEndsAt: '2026-12-01T03:00:00.000Z',
    eventIsActive: false,
  }, now), 'inativos');
});

test('rotulos de situacao sao texto, nao so cor', () => {
  assert.equal(ticketSituationLabel('ativos'), 'Ativo');
  assert.equal(ticketSituationLabel('anteriores'), 'Evento encerrado');
  assert.equal(ticketSituationLabel('cancelados'), 'Cancelado');
  assert.equal(ticketSituationLabel('inativos'), 'Inativo');
});

test('filtro de situacao padrao e ativos; valor invalido nao vira todos', () => {
  assert.equal(parseTicketSituationFilter(undefined), 'ativos');
  assert.equal(parseTicketSituationFilter(''), 'ativos');
  assert.equal(parseTicketSituationFilter('lixo'), 'ativos');
  assert.equal(parseTicketSituationFilter('todos'), 'todos');
  assert.equal(parseTicketSituationFilter('cancelados'), 'cancelados');
});

test('particiona ativo vs arquivo sem apagar nenhum ingresso', () => {
  const tickets = [
    { id: 'a', situation: 'ativos' },
    { id: 'b', situation: 'anteriores' },
    { id: 'c', situation: 'cancelados' },
    { id: 'd', situation: 'inativos' },
  ];
  const { active, archived } = partitionTicketsBySituation(tickets, (ticket) => ticket.situation);
  assert.deepEqual(active.map((ticket) => ticket.id), ['a']);
  assert.deepEqual(archived.map((ticket) => ticket.id), ['b', 'c', 'd']);
  assert.equal(active.length + archived.length, tickets.length);
});
