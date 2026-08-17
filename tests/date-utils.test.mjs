// Regressão do bug de corrupção de data date-only: um DATE do Postgres
// ("YYYY-MM-DD", sem hora) representa uma data de calendário, nunca um
// instante no tempo. Antes da correção, parseDateInput caía em
// `new Date("YYYY-MM-DD")` (parseado como meia-noite UTC) e formatDateBR
// lia de volta com getters locais -- em qualquer timezone atrás de UTC
// (todo o Brasil) isso devolvia o dia anterior. Estes testes fixam
// process.env.TZ ANTES de importar o módulo (Node relê TZ a cada acesso a
// Date, mas fixar cedo remove qualquer dependência do fuso da máquina que
// roda o teste).
process.env.TZ = 'America/Sao_Paulo';

import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDateBR, formatISOToDateBR, parseDateInput, formatDateTimeBR, calculateAgeFromDateBR } from '../src/lib/utils/date.ts';
import { calculateAgeAtDate } from '../src/lib/imports/import-row-validation.ts';

test('timezone do processo de teste é America/Sao_Paulo (UTC-3) -- pré-condição do bug', () => {
  assert.equal(new Date().getTimezoneOffset(), 180, 'sem isso os testes abaixo não provam nada sobre o bug real');
});

test('DATE-only "YYYY-MM-DD" nunca volta um dia em timezone negativo (bug original, corrigido)', () => {
  // Cada um destes teria retornado o dia anterior (ex.: 1990-01-01 ->
  // 31/12/1989) antes da correção do parseDateInput -- é exatamente o
  // teste que falhava antes e passa depois.
  assert.equal(formatDateBR('1990-01-01'), '01/01/1990');
  assert.equal(formatDateBR('1988-09-26'), '26/09/1988');
  assert.equal(formatDateBR('2000-02-29'), '29/02/2000'); // ano bissexto
  assert.equal(formatDateBR('2026-10-10'), '10/10/2026');
});

test('formatISOToDateBR (usado no checkout para pré-preencher o formulário) tem a mesma correção', () => {
  assert.equal(formatISOToDateBR('1990-01-01'), '01/01/1990');
  assert.equal(formatISOToDateBR('1988-09-26'), '26/09/1988');
  assert.equal(formatISOToDateBR(null), '');
  assert.equal(formatISOToDateBR(undefined), '');
});

test('parseDateInput preserva ano/mês/dia de calendário exatos para DATE-only, sem depender de hora', () => {
  const date = parseDateInput('1990-01-01');
  assert.equal(date.getFullYear(), 1990);
  assert.equal(date.getMonth(), 0);
  assert.equal(date.getDate(), 1);
});

test('DATE-only inválido (ex.: 31 de fevereiro) continua rejeitado, não "rola" para março', () => {
  assert.equal(parseDateInput('2021-02-31'), null);
  assert.equal(formatDateBR('2021-02-31'), '-');
});

test('formato DD/MM/YYYY (entrada manual do usuário) continua funcionando como antes', () => {
  assert.equal(formatDateBR('01/01/1990'), '01/01/1990');
  const date = parseDateInput('26/09/1988');
  assert.equal(date.getFullYear(), 1988);
  assert.equal(date.getMonth(), 8);
  assert.equal(date.getDate(), 26);
});

test('objeto Date já construído continua passando direto, sem re-parsing', () => {
  const original = new Date(2026, 4, 15, 10, 30);
  const parsed = parseDateInput(original);
  assert.equal(parsed, original);
});

test('timestamp real (com hora e offset) NÃO é tratado como date-only -- continua sendo um instante', () => {
  // 2026-08-18T01:30:00+00:00 é 17/08 às 22:30 em America/Sao_Paulo
  // (UTC-3) -- se este teste desse 18/08, a correção teria "vazado" para
  // timestamps reais e quebrado a semântica de instante.
  const date = parseDateInput('2026-08-18T01:30:00+00:00');
  assert.equal(date.getDate(), 17, 'timestamp real deve converter para o fuso local, diferente de DATE-only');
  assert.equal(date.getHours(), 22);
  assert.equal(date.getMinutes(), 30);
});

test('timestamp com hora do meio-dia não é achatado para meia-noite (hora não pode desaparecer)', () => {
  const date = parseDateInput('2026-08-17T15:45:00+00:00');
  assert.notEqual(date.getHours(), 0, 'se a hora sumiu, o valor foi tratado como date-only por engano');
  assert.equal(formatDateTimeBR('2026-08-17T15:45:00-03:00'), '17/08/2026 15:45');
});

test('maioridade (hoje) não sofre off-by-one por timezone -- fronteira de aniversário', () => {
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const brFromDate = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

  const turns18Today = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());
  const turns18Tomorrow = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate() + 1);
  const turned18Yesterday = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate() - 1);

  // O valor chega do banco como DATE-only ISO, igual customer_profiles.birth_date.
  assert.equal(calculateAgeFromDateBR(formatISOToDateBR(iso(turns18Today))), 18, 'completa 18 anos hoje');
  assert.equal(calculateAgeFromDateBR(formatISOToDateBR(iso(turns18Tomorrow))), 17, 'completa 18 anos amanhã -- ainda 17 hoje');
  assert.equal(calculateAgeFromDateBR(formatISOToDateBR(iso(turned18Yesterday))), 18, 'completou 18 anos ontem');

  // Confere que o BR formatado bate com o dia de calendário esperado (sem
  // o bug, nenhuma dessas datas deveria "vazar" um dia).
  assert.equal(formatISOToDateBR(iso(turns18Today)), brFromDate(turns18Today));
});

test('maioridade na data do EVENTO (calculateAgeAtDate, usado nas importações) -- fronteira exata', () => {
  const eventDate = '2026-10-10';
  // Nasceu exatamente 18 anos antes do evento -> completa 18 no dia do evento.
  assert.equal(calculateAgeAtDate('2008-10-10', eventDate), 18, 'completa 18 anos no dia do evento');
  // Nasceu 1 dia depois dessa data -> no dia do evento ainda tem 17 (o aniversário de 18 é no dia seguinte ao evento).
  assert.equal(calculateAgeAtDate('2008-10-11', eventDate), 17, 'completa 18 anos um dia depois do evento');
  // Nasceu 1 dia antes -> já completou 18 um dia antes do evento, no dia do evento tem 18.
  assert.equal(calculateAgeAtDate('2008-10-09', eventDate), 18, 'completou 18 anos um dia antes do evento');
});
