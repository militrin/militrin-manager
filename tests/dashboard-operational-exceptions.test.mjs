import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function isOperationalTicketStatus(status) {
  const normalized = String(status ?? '').toLowerCase();
  return normalized === 'active' || normalized === 'used';
}

function ticketHasCheckin(ticket) {
  return Boolean(ticket.used_at) || String(ticket.status ?? '') === 'used';
}

function ticketHasCompleteRequiredKit(ticket, requiredKitByEvent, kitsByTicket) {
  const required = requiredKitByEvent.get(String(ticket.event_id ?? '')) ?? [];
  const linked = kitsByTicket.get(String(ticket.id ?? '')) ?? [];
  return required.length > 0 && required.every((id) =>
    linked.some((kit) => String(kit.kit_item_id) === id && kit.status === 'delivered'),
  );
}

function isKitDeliveredWithoutCheckin(ticket, requiredKitByEvent, kitsByTicket) {
  return isOperationalTicketStatus(ticket.status)
    && ticketHasCompleteRequiredKit(ticket, requiredKitByEvent, kitsByTicket)
    && !ticketHasCheckin(ticket);
}

function isCheckinWithoutCompleteKit(ticket, requiredKitByEvent, kitsByTicket) {
  const required = requiredKitByEvent.get(String(ticket.event_id ?? '')) ?? [];
  return isOperationalTicketStatus(ticket.status)
    && required.length > 0
    && ticketHasCheckin(ticket)
    && !ticketHasCompleteRequiredKit(ticket, requiredKitByEvent, kitsByTicket);
}

function operationsTicketHref(eventId, ticketId, exception) {
  const params = new URLSearchParams();
  if (eventId && eventId !== 'all') params.set('eventId', eventId);
  if (exception === 'kit_without_checkin') {
    params.set('kitStatus', 'delivered');
    params.set('checkinStatus', 'pending');
  }
  params.set('focusTicket', ticketId);
  return `/operacoes?${params.toString()}`;
}

const EVENT = 'event-1';
const CUP = 'cup';
const SHIRT = 'shirt';
const requiredKitByEvent = new Map([[EVENT, [CUP, SHIRT]]]);

function kits(ticketId, statuses) {
  return new Map([[ticketId, statuses.map((status) => ({ kit_item_id: status.item, status: status.status }))]]);
}

test('kit entregue + sem check-in aparece na excecao', () => {
  const ticket = { id: 't-holder', event_id: EVENT, status: 'active', used_at: null };
  const kitMap = kits('t-holder', [
    { item: CUP, status: 'delivered' },
    { item: SHIRT, status: 'delivered' },
  ]);
  assert.equal(ticketHasCompleteRequiredKit(ticket, requiredKitByEvent, kitMap), true);
  assert.equal(ticketHasCheckin(ticket), false);
  assert.equal(isKitDeliveredWithoutCheckin(ticket, requiredKitByEvent, kitMap), true);
});

test('kit entregue + check-in feito nao aparece', () => {
  const ticket = { id: 't-ok', event_id: EVENT, status: 'used', used_at: '2026-09-22T20:00:00Z' };
  const kitMap = kits('t-ok', [
    { item: CUP, status: 'delivered' },
    { item: SHIRT, status: 'delivered' },
  ]);
  assert.equal(isKitDeliveredWithoutCheckin(ticket, requiredKitByEvent, kitMap), false);
});

test('kit incompleto + sem check-in nao aparece', () => {
  const ticket = { id: 't-partial', event_id: EVENT, status: 'active', used_at: null };
  const kitMap = kits('t-partial', [
    { item: CUP, status: 'delivered' },
    { item: SHIRT, status: 'reserved' },
  ]);
  assert.equal(ticketHasCompleteRequiredKit(ticket, requiredKitByEvent, kitMap), false);
  assert.equal(isKitDeliveredWithoutCheckin(ticket, requiredKitByEvent, kitMap), false);
});

test('excecao nao e kits KPI menos check-ins KPI', async () => {
  const source = await readFile(new URL('../src/lib/dashboard/admin-dashboard-data.ts', import.meta.url), 'utf8');
  const helpers = await readFile(new URL('../src/lib/dashboard/operational-exceptions.ts', import.meta.url), 'utf8');
  assert.match(source, /isKitDeliveredWithoutCheckin\(ticket, requiredKitByEvent, kitsByTicket\)/);
  assert.doesNotMatch(source, /completeTickets\.length\s*-/);
  assert.match(helpers, /kit completo entregue AND check-in pendente/i);
  assert.equal(isOperationalTicketStatus('cancelled'), false);
  const cancelled = { id: 't-x', event_id: EVENT, status: 'cancelled', used_at: null };
  const kitMap = kits('t-x', [
    { item: CUP, status: 'delivered' },
    { item: SHIRT, status: 'delivered' },
  ]);
  assert.equal(isKitDeliveredWithoutCheckin(cancelled, requiredKitByEvent, kitMap), false);
});

test('filtro abre ingresso correto na Central', () => {
  const href = operationsTicketHref(EVENT, '7e1ce025-8ac6-4c1a-b11e-8b5b01be1d30', 'kit_without_checkin');
  assert.match(href, /\/operacoes\?/);
  assert.match(href, /eventId=event-1/);
  assert.match(href, /kitStatus=delivered/);
  assert.match(href, /checkinStatus=pending/);
  assert.match(href, /focusTicket=7e1ce025-8ac6-4c1a-b11e-8b5b01be1d30/);
});

test('check-in com kit pendente e regra inversa, nao a mesma excecao', () => {
  const ticket = { id: 't-in', event_id: EVENT, status: 'used', used_at: '2026-09-22T20:00:00Z' };
  const kitMap = kits('t-in', [
    { item: CUP, status: 'delivered' },
    { item: SHIRT, status: 'reserved' },
  ]);
  assert.equal(isCheckinWithoutCompleteKit(ticket, requiredKitByEvent, kitMap), true);
  assert.equal(isKitDeliveredWithoutCheckin(ticket, requiredKitByEvent, kitMap), false);
});
