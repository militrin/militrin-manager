import assert from 'node:assert/strict';
import test from 'node:test';
import { foldOperationEvents } from '../src/lib/operations/history/fold-events.ts';
import { applyHistoryFilters, countOperationCards } from '../src/lib/operations/history/search.ts';

function raw(overrides) {
  return {
    id: overrides.id,
    occurredAt: overrides.occurredAt,
    action: overrides.action,
    source: overrides.source ?? 'audit',
    ticketId: overrides.ticketId ?? 'ticket-1',
    participantId: overrides.participantId ?? 'p-1',
    actorUserId: overrides.actorUserId ?? 'op-1',
    actorEmail: overrides.actorEmail ?? 'op@example.com',
    actorOrigin: overrides.actorOrigin ?? 'admin',
    reason: overrides.reason ?? null,
    entityType: overrides.entityType ?? 'tickets',
    entityId: overrides.entityId ?? 'ticket-1',
    details: overrides.details ?? { ticket_id: overrides.ticketId ?? 'ticket-1', actor_user_id: 'op-1' },
    previousParticipantId: overrides.previousParticipantId ?? null,
    nextParticipantId: overrides.nextParticipantId ?? null,
  };
}

function itemsAround(iso, actions) {
  return actions.map((action, index) => raw({
    id: `${action}-${index}`,
    action,
    occurredAt: new Date(Date.parse(iso) + index * 50).toISOString(),
  }));
}

test('4 itens + combined + kit_delivered canônico = 1 kit e 1 check-in', () => {
  const base = '2026-09-24T17:32:00.000Z';
  const events = [
    ...itemsAround(base, [
      'ticket_kit_item_delivered',
      'ticket_kit_item_delivered',
      'ticket_kit_item_delivered',
      'ticket_kit_item_delivered',
    ]),
    raw({ id: 'combined', action: 'combined_kit_delivery_and_checkin', occurredAt: '2026-09-24T17:32:00.400Z' }),
    raw({ id: 'canonical', action: 'kit_delivered', occurredAt: '2026-09-24T17:32:00.500Z', details: { shirt_type: 'Camiseta', shirt_size: 'M' } }),
  ];
  const folded = foldOperationEvents(events);
  const cards = countOperationCards(folded);
  assert.equal(cards.kitsDelivered, 1);
  assert.equal(cards.checkins, 1);
  assert.equal(folded.filter((item) => item.counts.kit).length, 1);
  assert.equal(folded.find((item) => item.counts.kit)?.grouping, 'canonical');
  assert.equal(folded.find((item) => item.counts.kit)?.title, 'KIT ENTREGUE + CHECK-IN');
});

test('precedência: canônico > combined > agrupamento legado', () => {
  const folded = foldOperationEvents([
    raw({ id: 'i1', action: 'ticket_kit_item_delivered', occurredAt: '2026-09-24T17:32:00.000Z' }),
    raw({ id: 'i2', action: 'ticket_kit_item_delivered', occurredAt: '2026-09-24T17:32:00.050Z' }),
    raw({ id: 'comb', action: 'combined_kit_delivery_and_checkin', occurredAt: '2026-09-24T17:32:00.100Z' }),
    raw({ id: 'can', action: 'kit_delivered', occurredAt: '2026-09-24T17:32:00.150Z' }),
  ]);
  const kitRows = folded.filter((item) => item.counts.kit);
  assert.equal(kitRows.length, 1);
  assert.equal(kitRows[0].grouping, 'canonical');
  assert.equal(folded.filter((item) => item.grouping === 'combined' && item.counts.kit).length, 0);
  assert.equal(folded.filter((item) => item.grouping === 'legacy' && item.counts.kit).length, 0);
});

test('histórico legado agrupa itens do mesmo ingresso+operador na janela e não reescreve logs', () => {
  const folded = foldOperationEvents([
    raw({ id: 'a', action: 'ticket_kit_item_delivered', occurredAt: '2026-09-24T17:32:00.000Z' }),
    raw({ id: 'b', action: 'ticket_kit_item_delivered', occurredAt: '2026-09-24T17:32:03.000Z' }),
    raw({ id: 'c', action: 'ticket_kit_item_delivered', occurredAt: '2026-09-24T17:32:08.000Z' }),
    raw({ id: 'd', action: 'ticket_kit_item_delivered', occurredAt: '2026-09-24T17:32:12.000Z' }),
  ]);
  assert.equal(countOperationCards(folded).kitsDelivered, 1);
  assert.equal(folded[0].grouping, 'legacy');
  assert.equal(folded[0].title, 'KIT ENTREGUE');
  assert.equal(folded[0].sourceIds.length, 4);
});

test('itens distantes (>15s) não viram a mesma entrega legada', () => {
  const folded = foldOperationEvents([
    raw({ id: 'a', action: 'ticket_kit_item_delivered', occurredAt: '2026-09-24T17:32:00.000Z' }),
    raw({ id: 'b', action: 'ticket_kit_item_delivered', occurredAt: '2026-09-24T17:32:20.000Z' }),
  ]);
  assert.equal(countOperationCards(folded).kitsDelivered, 2);
});

test('combined sem canônico conta kit + check-in uma vez só', () => {
  const folded = foldOperationEvents([
    raw({ id: 'i1', action: 'ticket_kit_item_delivered', occurredAt: '2026-09-24T17:32:00.000Z' }),
    raw({ id: 'i2', action: 'ticket_kit_item_delivered', occurredAt: '2026-09-24T17:32:00.080Z' }),
    raw({ id: 'c', action: 'combined_kit_delivery_and_checkin', occurredAt: '2026-09-24T17:32:00.200Z' }),
    raw({ id: 'k', action: 'ticket_checkin_entry', occurredAt: '2026-09-24T17:32:00.180Z' }),
  ]);
  const cards = countOperationCards(folded);
  assert.equal(cards.kitsDelivered, 1);
  assert.equal(cards.checkins, 1);
  assert.equal(folded.find((item) => item.counts.kit)?.grouping, 'combined');
});

test('desfazimento canônico + 4 undos de item = 1 correção, sem kit extra', () => {
  const folded = foldOperationEvents([
    raw({ id: 'u1', action: 'ticket_kit_item_delivery_undone', occurredAt: '2026-09-24T17:38:00.000Z' }),
    raw({ id: 'u2', action: 'ticket_kit_item_delivery_undone', occurredAt: '2026-09-24T17:38:00.050Z' }),
    raw({ id: 'u3', action: 'ticket_kit_item_delivery_undone', occurredAt: '2026-09-24T17:38:00.080Z' }),
    raw({ id: 'u4', action: 'ticket_kit_item_delivery_undone', occurredAt: '2026-09-24T17:38:00.110Z' }),
    raw({ id: 'undo', action: 'kit_delivery_undone', occurredAt: '2026-09-24T17:38:00.200Z', reason: 'Erro operacional' }),
  ]);
  const cards = countOperationCards(folded);
  assert.equal(cards.kitsDelivered, 0);
  assert.equal(cards.corrections, 1);
  assert.equal(folded[0].title, 'ENTREGA DE KIT DESFEITA');
  assert.equal(folded[0].grouping, 'canonical');
});

test('reentrega após undo gera novo kit_delivered (auditoria 14:32 / 14:38 / 14:41)', () => {
  const folded = foldOperationEvents([
    raw({ id: 'd1', action: 'kit_delivered', occurredAt: '2026-09-24T17:32:00.000Z' }),
    raw({ id: 'u1', action: 'kit_delivery_undone', occurredAt: '2026-09-24T17:38:00.000Z' }),
    raw({ id: 'd2', action: 'kit_delivered', occurredAt: '2026-09-24T17:41:00.000Z' }),
  ]);
  const cards = countOperationCards(folded);
  assert.equal(cards.kitsDelivered, 2);
  assert.equal(cards.corrections, 1);
  assert.deepEqual(folded.map((item) => item.title), [
    'KIT ENTREGUE',
    'ENTREGA DE KIT DESFEITA',
    'KIT ENTREGUE',
  ]);
});

test('emissão manual, titularidade, pulseira e check-in isolado contabilizam cards corretos', () => {
  const folded = foldOperationEvents([
    raw({ id: 'issue', action: 'manual_ticket_issued', occurredAt: '2026-09-24T16:45:00.000Z', details: { issue_reason: 'courtesy' } }),
    raw({ id: 'hold', action: 'holder_changed', occurredAt: '2026-09-24T16:58:00.000Z', source: 'holder', previousParticipantId: 'p-old', nextParticipantId: 'p-new' }),
    raw({ id: 'wb', action: 'wristband_linked', occurredAt: '2026-09-24T17:27:00.000Z', details: { code: 'AB8472' } }),
    raw({ id: 'ck', action: 'ticket_checkin_entry', occurredAt: '2026-09-24T17:29:00.000Z' }),
  ]);
  const cards = countOperationCards(folded);
  assert.equal(cards.manualIssues, 1);
  assert.equal(cards.corrections, 1);
  assert.equal(cards.wristbands, 1);
  assert.equal(cards.checkins, 1);
  assert.equal(cards.kitsDelivered, 0);
  assert.equal(folded.find((item) => item.counts.wristband)?.wristbandLabel, '••••8472');
  assert.equal(folded.find((item) => item.counts.manualIssue)?.title, 'INGRESSO EMITIDO');
});

test('filtros de categoria, operador e busca não usam só a página visível — operam no conjunto dobrado', () => {
  const folded = foldOperationEvents([
    raw({ id: 'k', action: 'kit_delivered', occurredAt: '2026-09-24T17:32:00.000Z', actorUserId: 'op-1' }),
    raw({ id: 'c', action: 'ticket_checkin_entry', occurredAt: '2026-09-24T17:29:00.000Z', actorUserId: 'op-2', ticketId: 'ticket-2' }),
  ]).map((item, index) => ({
    ...item,
    participantName: index === 0 ? 'Letícia Martinotto' : 'João da Silva',
    ticketCode: index === 0 ? '#001546-01' : '#001843-01',
    operatorName: index === 0 ? 'Douglas Hobold' : 'Operador X',
    orderNumber: index === 0 ? '#001546' : '#001843',
  }));
  const onlyKit = applyHistoryFilters(folded, { category: 'kit' });
  assert.equal(countOperationCards(onlyKit).kitsDelivered, 1);
  assert.equal(countOperationCards(onlyKit).checkins, 0);
  const byOperator = applyHistoryFilters(folded, { operatorUserId: 'op-2' });
  assert.equal(byOperator.length, 1);
  assert.equal(byOperator[0].title, 'CHECK-IN REALIZADO');
  const searchTicket = applyHistoryFilters(folded, { search: '001546' });
  assert.equal(searchTicket.length, 1);
  const searchName = applyHistoryFilters(folded, { search: 'leticia' });
  assert.equal(searchName.length, 1);
  const searchOperator = applyHistoryFilters(folded, { search: 'douglas' });
  assert.equal(searchOperator.length, 1);
  const noMatch = applyHistoryFilters(folded, { search: 'pedido-inexistente' });
  assert.equal(noMatch.length, 0);
});
