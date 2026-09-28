import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { foldOperationEvents } from '../src/lib/operations/history/fold-events.ts';
import { paginateByCursor } from '../src/lib/operations/history/paginate.ts';
import { resolveHistoryPeriod, periodToIsoBounds } from '../src/lib/operations/history/period.ts';
import {
  extraHistoryFilterCount,
  formatFeedOccurredAt,
  formatHistoryPeriodLabel,
  shirtDeliverySummaryCards,
} from '../src/lib/operations/history/presentation.ts';
import { applyHistoryFilters } from '../src/lib/operations/history/search.ts';
import {
  annotateKitDeliveryLifecycle,
  countShirtDeliverySummary,
  deliveryStatusLabel,
  inheritUndoShirtFromPriorDeliveries,
  parseShirtFromDetails,
  shirtDeliveriesHeading,
  shirtMatchesFilter,
} from '../src/lib/operations/history/shirt-from-audit.ts';
import { parseHistorySearchParams, shirtDeliveriesHref } from '../src/lib/operations/history/url.ts';

function raw(overrides) {
  return {
    id: overrides.id,
    occurredAt: overrides.occurredAt,
    action: overrides.action,
    source: overrides.source ?? 'audit',
    ticketId: overrides.ticketId ?? 'ticket-exgg',
    participantId: overrides.participantId ?? 'p-1',
    actorUserId: overrides.actorUserId ?? 'op-1',
    actorEmail: overrides.actorEmail ?? 'op@example.com',
    actorOrigin: overrides.actorOrigin ?? 'admin',
    reason: overrides.reason ?? null,
    entityType: overrides.entityType ?? 'tickets',
    entityId: overrides.entityId ?? 'ticket-exgg',
    details: overrides.details ?? { ticket_id: overrides.ticketId ?? 'ticket-exgg', actor_user_id: 'op-1' },
    previousParticipantId: overrides.previousParticipantId ?? null,
    nextParticipantId: overrides.nextParticipantId ?? null,
  };
}

function withNames(items, names) {
  return items.map((item, index) => ({
    ...item,
    participantName: names[index]?.participantName ?? item.participantName,
    ticketCode: names[index]?.ticketCode ?? item.ticketCode,
    orderNumber: names[index]?.orderNumber ?? item.orderNumber,
    operatorName: names[index]?.operatorName ?? 'Douglas',
  }));
}

test('A. entrega EXGG preserva tamanho histórico no fold canônico', () => {
  const parsed = parseShirtFromDetails({ shirt_type: 'Camiseta', shirt_size: 'EXGG' });
  assert.equal(parsed.label, 'Camiseta EXGG');
  const folded = foldOperationEvents([
    raw({
      id: 'd1',
      action: 'kit_delivered',
      occurredAt: '2026-09-26T22:32:00.000Z',
      details: { shirt_type: 'Camiseta', shirt_size: 'EXGG', ticket_id: 'ticket-exgg' },
    }),
  ]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].shirtLabel, 'Camiseta EXGG');
  assert.equal(folded[0].title, 'KIT ENTREGUE');
  assert.equal(shirtMatchesFilter(folded[0], 'Camiseta', 'EXGG'), true);
});

test('B. entrega EXGG + undo herda tamanho no undo e marca DESFEITA', () => {
  const folded = foldOperationEvents([
    raw({
      id: 'd1',
      action: 'kit_delivered',
      occurredAt: '2026-09-26T22:32:00.000Z',
      details: { shirt_type: 'Camiseta', shirt_size: 'EXGG', ticket_id: 'ticket-exgg' },
    }),
    raw({
      id: 'u1',
      action: 'kit_delivery_undone',
      occurredAt: '2026-09-26T22:40:00.000Z',
      reason: 'Tamanho errado',
    }),
  ]);
  const annotated = annotateKitDeliveryLifecycle(folded);
  const delivery = annotated.find((item) => item.counts.kit);
  const undo = annotated.find((item) => item.title === 'ENTREGA DE KIT DESFEITA');
  assert.equal(delivery?.deliveryStatus, 'delivered');
  assert.equal(undo?.deliveryStatus, 'undone');
  assert.equal(undo?.shirtLabel, 'Camiseta EXGG');
  assert.equal(deliveryStatusLabel(undo?.deliveryStatus), 'DESFEITA');
  const summary = countShirtDeliverySummary(annotated);
  assert.equal(summary.periodDeliveries, 1);
  assert.equal(summary.periodUndos, 1);
});

test('C. entrega + undo + reentrega marca REENTREGUE e mantém a história', () => {
  const folded = foldOperationEvents([
    raw({
      id: 'd1',
      action: 'kit_delivered',
      occurredAt: '2026-09-26T22:32:00.000Z',
      details: { shirt_type: 'Camiseta', shirt_size: 'EXGG', ticket_id: 'ticket-exgg' },
    }),
    raw({ id: 'u1', action: 'kit_delivery_undone', occurredAt: '2026-09-26T22:40:00.000Z' }),
    raw({
      id: 'd2',
      action: 'kit_delivered',
      occurredAt: '2026-09-26T22:45:00.000Z',
      details: { shirt_type: 'Camiseta', shirt_size: 'EXGG', ticket_id: 'ticket-exgg' },
    }),
  ]);
  const annotated = annotateKitDeliveryLifecycle(folded);
  const byTime = [...annotated].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  assert.equal(byTime[0].deliveryStatus, 'delivered');
  assert.equal(byTime[1].deliveryStatus, 'undone');
  assert.equal(byTime[2].deliveryStatus, 'redelivered');
  assert.equal(deliveryStatusLabel(byTime[2].deliveryStatus), 'REENTREGUE');
  const summary = countShirtDeliverySummary(annotated);
  assert.equal(summary.periodDeliveries, 2);
  assert.equal(summary.periodUndos, 1);
});

test('D. troca posterior de tamanho não reescreve a entrega antiga', () => {
  const folded = foldOperationEvents([
    raw({
      id: 'd1',
      action: 'kit_delivered',
      occurredAt: '2026-09-26T22:32:00.000Z',
      details: { shirt_type: 'Camiseta', shirt_size: 'EXGG', ticket_id: 'ticket-exgg' },
    }),
    raw({
      id: 'chg',
      action: 'ticket_shirt_admin_changed',
      occurredAt: '2026-09-27T12:00:00.000Z',
      details: {
        previous_shirt_type: 'Camiseta',
        previous_shirt_size: 'EXGG',
        shirt_type: 'Camiseta',
        shirt_size: 'G',
        ticket_id: 'ticket-exgg',
      },
    }),
  ]);
  const delivery = folded.find((item) => item.counts.kit);
  const change = folded.find((item) => item.title === 'CAMISETA ALTERADA');
  assert.equal(delivery.shirtLabel, 'Camiseta EXGG');
  assert.equal(change.stateChanges[0].previous, 'Camiseta EXGG');
  assert.equal(change.stateChanges[0].next, 'Camiseta G');
  const exgg = applyHistoryFilters(folded, { shirtType: 'Camiseta', shirtSize: 'EXGG' });
  assert.equal(exgg.some((item) => item.id === 'd1'), true);
  assert.equal(shirtMatchesFilter(delivery, 'Camiseta', 'EXGG'), true);
  assert.equal(shirtMatchesFilter({ shirtLabel: 'Camiseta G', stateChanges: [] }, 'Camiseta', 'EXGG'), false);
});

test('E. filtro Hoje usa o calendário BRT', () => {
  const now = new Date('2026-09-27T02:30:00-03:00');
  assert.deepEqual(resolveHistoryPeriod({ period: 'today', now }), { dateFrom: '2026-09-27', dateTo: '2026-09-27' });
  const bounds = periodToIsoBounds('2026-09-27', '2026-09-27');
  assert.equal(bounds.fromIso, '2026-09-27T00:00:00-03:00');
  assert.equal(bounds.toIso, '2026-09-27T23:59:59.999-03:00');
});

test('F. filtro Ontem respeita America/Sao_Paulo, não UTC', () => {
  const still26BRT = new Date('2026-09-27T02:30:00.000Z');
  assert.deepEqual(resolveHistoryPeriod({ period: 'today', now: still26BRT }), { dateFrom: '2026-09-26', dateTo: '2026-09-26' });
  assert.deepEqual(resolveHistoryPeriod({ period: 'yesterday', now: still26BRT }), { dateFrom: '2026-09-25', dateTo: '2026-09-25' });
  const afterMidnightBRT = new Date('2026-09-27T03:30:00.000Z');
  assert.deepEqual(resolveHistoryPeriod({ period: 'today', now: afterMidnightBRT }), { dateFrom: '2026-09-27', dateTo: '2026-09-27' });
  assert.deepEqual(resolveHistoryPeriod({ period: 'yesterday', now: afterMidnightBRT }), { dateFrom: '2026-09-26', dateTo: '2026-09-26' });
  const bounds = periodToIsoBounds('2026-09-26', '2026-09-26');
  assert.equal(bounds.fromIso, '2026-09-26T00:00:00-03:00');
  assert.equal(formatHistoryPeriodLabel({ period: 'yesterday', dateFrom: '2026-09-26', dateTo: '2026-09-26' }), 'Ontem · 26/09/2026 · America/Sao_Paulo');
});

test('G. período personalizado aceita intervalo explícito', () => {
  const now = new Date('2026-09-27T18:00:00-03:00');
  assert.deepEqual(
    resolveHistoryPeriod({ period: 'custom', dateFrom: '2026-09-20', dateTo: '2026-09-26', now }),
    { dateFrom: '2026-09-20', dateTo: '2026-09-26' },
  );
  assert.match(
    formatHistoryPeriodLabel({ period: 'custom', dateFrom: '2026-09-20', dateTo: '2026-09-26' }),
    /Personalizado · 20\/09\/2026 → 26\/09\/2026/,
  );
});

test('H. pesquisa reutiliza nome, ingresso e pedido do histórico', () => {
  const folded = withNames(foldOperationEvents([
    raw({
      id: 'd1',
      action: 'kit_delivered',
      occurredAt: '2026-09-26T22:32:00.000Z',
      details: { shirt_type: 'Camiseta', shirt_size: 'EXGG', ticket_id: 'ticket-exgg' },
    }),
  ]), [{ participantName: 'Higor Luis Bandeira', ticketCode: '#001111-01', orderNumber: '#001111' }]);
  assert.equal(applyHistoryFilters(folded, { search: 'higor' }).length, 1);
  assert.equal(applyHistoryFilters(folded, { search: '001111' }).length, 1);
  assert.equal(applyHistoryFilters(folded, { search: 'rita' }).length, 0);
});

test('I. paginação ocorre depois do filtro de tamanho', () => {
  const items = Array.from({ length: 60 }, (_, index) => {
    const isExgg = index < 55;
    return {
      ...foldOperationEvents([
        raw({
          id: `d-${index}`,
          action: 'kit_delivered',
          occurredAt: new Date(Date.parse('2026-09-26T22:00:00.000Z') + index * 1000).toISOString(),
          ticketId: `ticket-${index}`,
          entityId: `ticket-${index}`,
          details: { shirt_type: 'Camiseta', shirt_size: isExgg ? 'EXGG' : 'G', ticket_id: `ticket-${index}` },
        }),
      ])[0],
    };
  });
  const filtered = applyHistoryFilters(items, { shirtType: 'Camiseta', shirtSize: 'EXGG' });
  assert.equal(filtered.length, 55);
  const first = paginateByCursor(filtered, null, 50);
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  assert.equal(first.items.every((item) => item.shirtLabel === 'Camiseta EXGG'), true);
  const second = paginateByCursor(filtered, first.nextCursor, 50);
  assert.equal(second.items.length, 5);
  assert.equal(second.nextCursor, null);
});

test('J. Ver entregas exige operations.view_report e não inventa outra fonte', async () => {
  const [query, table, page, client, layout] = await Promise.all([
    readFile(new URL('../src/lib/operations/history/query.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/mvp/ShirtStockTable.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/camisetas/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/operacoes/relatorio/operations-history-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/operacoes/relatorio/layout.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(query, /assertPermission\("operations.view_report"\)/);
  assert.match(layout, /requirePermission\("operations.view_report"\)/);
  assert.match(page, /"operations\.view_report"/);
  assert.match(page, /canViewDeliveries=\{Boolean\(permissionMap\["operations\.view_report"\]\)\}/);
  assert.match(table, /canViewDeliveries \? \(/);
  assert.match(table, /Ver entregas/);
  assert.match(table, /shirtDeliveriesHref/);
  assert.doesNotMatch(query, /\.from\("order_items"\)[\s\S]*shirt_type/);
  assert.match(query, /registration_contact_id/);
  assert.match(client, /\/cadastros\/\$\{selected\.contactId\}/);
  assert.match(client, /\/ingressos\/\$\{selected\.ticketId\}/);
  assert.match(client, /\/inscricoes\/pedido\/\$\{selected\.orderId\}/);
  assert.equal(
    shirtDeliveriesHref({ eventId: 'evt', shirtType: 'Camiseta', shirtSize: 'EXGG' }),
    '/operacoes/relatorio?eventId=evt&period=today&category=kit&shirtType=Camiseta&shirtSize=EXGG',
  );
  const babylook = shirtDeliveriesHref({ eventId: '17e8ecdd-5acf-4048-bc52-b47817d42e23', shirtType: 'Babylook', shirtSize: 'PP' });
  assert.match(babylook, /shirtType=Babylook/);
  assert.match(babylook, /shirtSize=PP/);
  assert.match(babylook, /eventId=17e8ecdd-5acf-4048-bc52-b47817d42e23/);
});

test('K. Ontem no feed, cards honestos e lista mobile sem tabela', async () => {
  const now = new Date('2026-09-27T18:00:00-03:00');
  assert.equal(formatFeedOccurredAt('2026-09-26T22:32:00.000Z', 'yesterday', now), '19:32');
  assert.equal(extraHistoryFilterCount({ period: 'yesterday', category: 'kit', operatorUserId: '', shirtType: 'Camiseta', shirtSize: 'EXGG' }), 4);
  const cards = shirtDeliverySummaryCards({ periodDeliveries: 3, periodUndos: 1, currentlyDelivered: 2 });
  assert.deepEqual(cards.map((card) => card.key), ['saidas', 'undos', 'estoqueAtual']);
  assert.deepEqual(cards.map((card) => card.label), ['Saídas no período', 'Undos no período', 'Estoque atual entregue']);
  assert.equal(cards[0].value + cards[1].value === cards[2].value, false);
  assert.match(cards[2].hint, /Não é o saldo do período/);
  assert.equal(shirtDeliveriesHeading('Camiseta', 'EXGG'), 'Entregas — Camiseta EXGG');
  const parsed = parseHistorySearchParams({ period: 'yesterday', shirtType: 'Babylook', shirtSize: 'M', category: 'kit' });
  assert.equal(parsed.period, 'yesterday');
  assert.equal(parsed.shirtType, 'Babylook');
  const client = await readFile(new URL('../src/app/operacoes/relatorio/operations-history-client.tsx', import.meta.url), 'utf8');
  assert.match(client, /divide-y divide-slate-800/);
  assert.doesNotMatch(client, /<table/);
  assert.match(client, /Nome, ingresso ou pedido/);
  const table = await readFile(new URL('../src/components/mvp/ShirtStockTable.tsx', import.meta.url), 'utf8');
  assert.match(table, /md:hidden/);
  assert.match(table, /Ver entregas/);
});

function cycleEvents() {
  return foldOperationEvents([
    raw({
      id: 'd-exgg',
      action: 'kit_delivered',
      occurredAt: '2026-09-25T22:00:00.000Z',
      details: { shirt_type: 'Camiseta', shirt_size: 'EXGG', ticket_id: 'ticket-exgg' },
    }),
    raw({ id: 'u-exgg', action: 'kit_delivery_undone', occurredAt: '2026-09-25T22:10:00.000Z' }),
    raw({
      id: 'd-g',
      action: 'kit_delivered',
      occurredAt: '2026-09-25T22:20:00.000Z',
      details: { shirt_type: 'Camiseta', shirt_size: 'G', ticket_id: 'ticket-exgg' },
    }),
    raw({ id: 'u-g', action: 'kit_delivery_undone', occurredAt: '2026-09-25T22:30:00.000Z' }),
  ]);
}

test('gate 1A: segundo undo não herda EXGG depois da reentrega G', () => {
  const annotated = annotateKitDeliveryLifecycle(cycleEvents());
  const byTime = [...annotated].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  assert.deepEqual(byTime.map((item) => [item.id, item.shirtLabel, item.deliveryStatus]), [
    ['d-exgg', 'Camiseta EXGG', 'delivered'],
    ['u-exgg', 'Camiseta EXGG', 'undone'],
    ['d-g', 'Camiseta G', 'redelivered'],
    ['u-g', 'Camiseta G', 'undone'],
  ]);
  assert.notEqual(byTime[3].shirtLabel, 'Camiseta EXGG');
});

test('gate 1B: filtro EXGG vê entrega+undo; filtro G vê a entrega G', () => {
  const annotated = annotateKitDeliveryLifecycle(foldOperationEvents([
    raw({
      id: 'd-exgg',
      action: 'kit_delivered',
      occurredAt: '2026-09-25T22:00:00.000Z',
      details: { shirt_type: 'Camiseta', shirt_size: 'EXGG', ticket_id: 'ticket-exgg' },
    }),
    raw({ id: 'u-exgg', action: 'kit_delivery_undone', occurredAt: '2026-09-25T22:10:00.000Z' }),
    raw({
      id: 'd-g',
      action: 'kit_delivered',
      occurredAt: '2026-09-25T22:20:00.000Z',
      details: { shirt_type: 'Camiseta', shirt_size: 'G', ticket_id: 'ticket-exgg' },
    }),
  ]));
  const exgg = applyHistoryFilters(annotated, { shirtType: 'Camiseta', shirtSize: 'EXGG' });
  assert.deepEqual(exgg.map((item) => item.id).sort(), ['d-exgg', 'u-exgg']);
  const g = applyHistoryFilters(annotated, { shirtType: 'Camiseta', shirtSize: 'G' });
  assert.deepEqual(g.map((item) => item.id), ['d-g']);
});

test('gate 1C: undo no dia seguinte herda o tamanho da entrega anterior inequívoca', () => {
  const undoOnly = foldOperationEvents([
    raw({ id: 'u-next-day', action: 'kit_delivery_undone', occurredAt: '2026-09-26T12:00:00.000Z' }),
  ]);
  const annotated = annotateKitDeliveryLifecycle(undoOnly);
  assert.equal(annotated[0].shirtLabel, null);
  const inherited = inheritUndoShirtFromPriorDeliveries(annotated, [
    { ticketId: 'ticket-exgg', occurredAt: '2026-09-25T22:00:00.000Z', label: 'Camiseta EXGG' },
    { ticketId: 'ticket-exgg', occurredAt: '2026-09-26T13:00:00.000Z', label: 'Camiseta G' },
  ]);
  assert.equal(inherited[0].shirtLabel, 'Camiseta EXGG');
});

test('gate 1C: backfill escolhe a entrega mais recente do ciclo, não a primeira da lista concatenada', () => {
  const undoOnly = foldOperationEvents([
    raw({ id: 'u-g', action: 'kit_delivery_undone', occurredAt: '2026-09-26T22:30:00.000Z' }),
  ]);
  const inherited = inheritUndoShirtFromPriorDeliveries(undoOnly, [
    { ticketId: 'ticket-exgg', occurredAt: '2026-09-25T22:00:00.000Z', label: 'Camiseta EXGG' },
    { ticketId: 'ticket-exgg', occurredAt: '2026-09-26T22:20:00.000Z', label: 'Camiseta G' },
  ]);
  assert.equal(inherited[0].shirtLabel, 'Camiseta G');
});

test('gate 1D: sem informação suficiente permanece sem tamanho histórico', () => {
  const unlabeled = foldOperationEvents([
    raw({ id: 'd-old', action: 'kit_delivered', occurredAt: '2026-09-20T12:00:00.000Z', details: { ticket_id: 'ticket-exgg' } }),
    raw({ id: 'u-old', action: 'kit_delivery_undone', occurredAt: '2026-09-20T12:10:00.000Z' }),
  ]);
  const annotated = annotateKitDeliveryLifecycle(unlabeled);
  const inherited = inheritUndoShirtFromPriorDeliveries(annotated, [
    { ticketId: 'ticket-exgg', occurredAt: '2026-09-20T12:00:00.000Z', label: null },
  ]);
  assert.equal(inherited.find((item) => item.id === 'd-old')?.shirtLabel, null);
  assert.equal(inherited.find((item) => item.id === 'u-old')?.shirtLabel, null);
  assert.equal(countShirtDeliverySummary(inherited).unknownSize, 2);
});

test('nova entrega sem tamanho não reaproveita a camiseta do ciclo anterior', () => {
  const folded = foldOperationEvents([
    raw({
      id: 'd-exgg',
      action: 'kit_delivered',
      occurredAt: '2026-09-25T22:00:00.000Z',
      details: { shirt_type: 'Camiseta', shirt_size: 'EXGG', ticket_id: 'ticket-exgg' },
    }),
    raw({ id: 'u-exgg', action: 'kit_delivery_undone', occurredAt: '2026-09-25T22:10:00.000Z' }),
    raw({ id: 'd-unknown', action: 'kit_delivered', occurredAt: '2026-09-25T22:20:00.000Z', details: { ticket_id: 'ticket-exgg' } }),
    raw({ id: 'u-unknown', action: 'kit_delivery_undone', occurredAt: '2026-09-25T22:30:00.000Z' }),
  ]);
  const annotated = annotateKitDeliveryLifecycle(folded);
  assert.equal(annotated.find((item) => item.id === 'u-exgg')?.shirtLabel, 'Camiseta EXGG');
  assert.equal(annotated.find((item) => item.id === 'd-unknown')?.shirtLabel, null);
  assert.equal(annotated.find((item) => item.id === 'u-unknown')?.shirtLabel, null);
});

test('query aplica período e action no fetch e correlaciona undo depois, sem shirt atual', async () => {
  const query = await readFile(new URL('../src/lib/operations/history/query.ts', import.meta.url), 'utf8');
  assert.match(query, /\.in\("action", \[\.\.\.actions\]\)/);
  assert.match(query, /\.gte\("created_at", fromIso\)/);
  assert.match(query, /annotateKitDeliveryLifecycle\(folded\)/);
  assert.match(query, /backfillUndoShirtFromPriorDeliveries\(event\.id, sameWindowLifecycle\)/);
  assert.doesNotMatch(query, /order_items[\s\S]*shirt_size/);
});
