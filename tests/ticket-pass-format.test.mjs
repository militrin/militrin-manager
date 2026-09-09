import test from 'node:test';
import assert from 'node:assert/strict';
import { formatEventPassDate, formatEventPassOrderNumber, buildTicketPassViewModel, ticketPassExportFileStem } from '../src/components/ticket-pass/ticket-pass-format.ts';

test('formata data e hora do evento em America/Sao_Paulo, sem segundos', () => {
  const parts = formatEventPassDate('2026-10-10T10:00:00.000Z');
  assert.deepEqual(parts, { day: '10', month: 'OUT', year: '2026', time: '07:00' });
});

test('timestamp ISO sem fuso e interpretado em UTC e exibido em America/Sao_Paulo', () => {
  assert.deepEqual(formatEventPassDate('2026-10-10T10:00:00'), { day: '10', month: 'OUT', year: '2026', time: '07:00' });
});

test('data de calendario pura nao inventa horario 00:00', () => {
  const parts = formatEventPassDate('2026-10-10');
  assert.equal(parts?.day, '10');
  assert.equal(parts?.month, 'OUT');
  assert.equal(parts?.year, '2026');
  assert.equal(parts?.time, null);
});

test('numero de pedido legado vira referencia de vitrine', () => {
  assert.equal(formatEventPassOrderNumber('MIL-2026-1120'), '#001120');
  assert.equal(formatEventPassOrderNumber('#001120'), '#001120');
  assert.equal(formatEventPassOrderNumber('sem número'), null);
});

test('view model do Event Pass usa dados reais e status ATIVO sem mock', () => {
  const model = buildTicketPassViewModel({
    eventName: 'Militrin',
    participantName: 'Douglas Hobold',
    status: 'active',
    categoryName: 'Open Bar',
    eventDate: '2026-10-10T10:00:00.000Z',
    eventLocation: 'Complexo Oktoberfest',
    token: 'not-printed',
    orderNumber: '#001120',
  });
  assert.equal(model.eventName, 'Militrin');
  assert.equal(model.categoryName, 'Open Bar');
  assert.equal(model.holderName, 'Douglas Hobold');
  assert.equal(model.orderNumber, '#001120');
  assert.equal(model.statusIsActive, true);
  assert.equal(model.statusText, 'ATIVO');
  assert.deepEqual(model.dateParts, { day: '10', month: 'OUT', year: '2026', time: '07:00' });
  assert.equal(ticketPassExportFileStem(model), 'acesso-militrin-001120');
});

test('TICKET_PASS_COPY comunica retirada do kit e nao entrada do evento', async () => {
  const { TICKET_PASS_COPY } = await import('../src/components/ticket-pass/ticket-pass-format.ts');
  assert.equal(TICKET_PASS_COPY.eyebrow, 'Acesso Militrin');
  assert.equal(TICKET_PASS_COPY.qrPurpose, 'QR para retirada do kit');
  assert.match(TICKET_PASS_COPY.qrInstructionLine2, /ponto de retirada do Militrin/i);
  assert.doesNotMatch(TICKET_PASS_COPY.qrInstructionLine1, /entrada do evento/i);
  assert.doesNotMatch(TICKET_PASS_COPY.qrInstructionLine2, /entrada do evento|entrar no evento|acesso ao evento/i);
  assert.match(TICKET_PASS_COPY.oktoberfestNoticeTitle, /Oktoberfest não incluso/i);
  assert.match(TICKET_PASS_COPY.oktoberfestNoticeBody, /Ala Jovem/i);
});
