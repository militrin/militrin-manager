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
import {
  formatDateBR,
  formatISOToDateBR,
  parseDateInput,
  formatDateTimeBR,
  calculateAgeAtEventDate,
  isMinimumAgeSatisfied,
} from '../src/lib/utils/date.ts';
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

// ============================================================
// Regra canônica única de maioridade: idade na DATA DO EVENTO, nunca na
// data da compra. Antes desta unificação existiam duas semânticas
// divergentes (checkout usava idade "hoje"; importações usavam idade no
// evento) -- calculateAgeAtEventDate (src/lib/utils/date.ts) é agora a
// única fonte, consumida tanto pelo checkout público (src/app/inscricao/
// actions.ts) quanto pelas importações (via o wrapper calculateAgeAtDate
// em src/lib/imports/import-row-validation.ts).
// ============================================================

test('maioridade na data do evento: fronteira exata (no dia / um dia antes / um dia depois)', () => {
  const eventDate = '2026-10-10';
  assert.equal(calculateAgeAtEventDate('2008-10-10', eventDate), 18, 'completa 18 anos exatamente no dia do evento');
  assert.equal(calculateAgeAtEventDate('2008-10-11', eventDate), 17, 'completaria 18 um dia depois do evento -- no evento ainda tem 17');
  assert.equal(calculateAgeAtEventDate('2008-10-09', eventDate), 18, 'completou 18 anos um dia antes do evento');
});

test('maioridade em ano bissexto: nascimento em 29/02', () => {
  // Nascido em 29/02/2008 (2008 é bissexto). Evento em 2028 (também
  // bissexto) exatamente no dia 29/02 -- aniversário "literal" já ocorreu.
  assert.equal(calculateAgeAtEventDate('2008-02-29', '2028-02-29'), 20, 'evento cai exatamente no 29/02 de outro ano bissexto');
  // Evento em 2027 (não-bissexto, sem 29/02): em 28/02 o aniversário de
  // 29/02 ainda não "ocorreu" nesse ano -- só no dia seguinte (1º de março)
  // é que a idade avança, pela mesma comparação mês/dia usada para
  // qualquer outra data.
  assert.equal(calculateAgeAtEventDate('2008-02-29', '2027-02-28'), 18, 'véspera do "aniversário" de quem nasceu em 29/02, em ano não-bissexto');
  assert.equal(calculateAgeAtEventDate('2008-02-29', '2027-03-01'), 19, 'primeiro dia após o "aniversário" de 29/02 num ano não-bissexto');
});

test('timestamptz real do evento (events.starts_at) é convertido para o dia de calendário em America/Sao_Paulo, não no fuso do processo', () => {
  // 2026-10-10T02:00:00Z é 09/10 às 23:00 em America/Sao_Paulo (UTC-3) --
  // ou seja, o "dia do evento" em Brasília é 09/10, não 10/10, mesmo que o
  // processo que roda o teste esteja em outro fuso.
  assert.equal(calculateAgeAtEventDate('2008-10-09', '2026-10-10T02:00:00Z'), 18, 'instante cai em 09/10 no fuso do evento -- já fez 18');
  assert.equal(calculateAgeAtEventDate('2008-10-10', '2026-10-10T02:00:00Z'), 17, 'instante cai em 09/10 no fuso do evento -- aniversário de 10/10 ainda não chegou');
  // Um evento à tarde, sem ambiguidade de fuso, cai no mesmo dia em qualquer leitura.
  assert.equal(calculateAgeAtEventDate('2008-10-10', '2026-10-10T15:00:00-03:00'), 18);
});

test('evento sem idade mínima (min_age = 0 ou nulo) sempre satisfaz, sem nem olhar a data', () => {
  assert.equal(isMinimumAgeSatisfied('2020-01-01', null, 0), true, 'min_age 0 aprova mesmo sem starts_at válido');
  assert.equal(isMinimumAgeSatisfied('2020-01-01', null, null), true);
  assert.equal(isMinimumAgeSatisfied(null, null, 0), true, 'nem precisa de nascimento quando não há exigência de idade');
});

test('evento sem starts_at válido: não inventa fallback -- retorna null explicitamente quando há exigência de idade', () => {
  assert.equal(calculateAgeAtEventDate('1990-01-01', null), null);
  assert.equal(calculateAgeAtEventDate('1990-01-01', 'data-invalida'), null);
  assert.equal(isMinimumAgeSatisfied('1990-01-01', null, 18), null, 'não pode decidir permitido nem bloqueado sem a data do evento');
  assert.notEqual(isMinimumAgeSatisfied('1990-01-01', null, 18), true, 'nunca "permite" silenciosamente por falta de dado');
});

test('nascimento inválido também retorna null, nunca uma idade inventada', () => {
  assert.equal(calculateAgeAtEventDate('2021-02-31', '2026-10-10'), null);
  assert.equal(calculateAgeAtEventDate(null, '2026-10-10'), null);
});

test('nascimento posterior à data do evento retorna null (pessoa ainda não nascida no evento)', () => {
  assert.equal(calculateAgeAtEventDate('2027-01-01', '2026-08-09T09:00:00Z'), null);
});

test('alterar a data do evento recalcula a elegibilidade corretamente', () => {
  const birthDate = '2008-10-10';
  assert.equal(isMinimumAgeSatisfied(birthDate, '2026-10-09', 18), false, 'evento um dia antes do aniversário de 18 -- ainda não pode');
  assert.equal(isMinimumAgeSatisfied(birthDate, '2026-10-10', 18), true, 'evento remarcado para o dia do aniversário -- já pode');
  assert.equal(isMinimumAgeSatisfied(birthDate, '2027-10-10', 18), true, 'evento adiado um ano -- continua podendo');
});

test('checkout (calculateAgeAtEventDate) e importações (calculateAgeAtDate) concordam exatamente na mesma decisão', () => {
  const cases = [
    ['2008-10-10', '2026-10-10'],
    ['2008-10-11', '2026-10-10'],
    ['2008-10-09', '2026-10-10'],
    ['2010-02-29', '2028-02-29'],
    ['2027-01-01', '2026-08-09T09:00:00Z'],
    ['2008-08-10', '2026-08-09T09:00:00Z'],
    ['2008-08-09', '2026-08-09T09:00:00Z'],
  ];
  for (const [birthDate, eventDate] of cases) {
    assert.equal(
      calculateAgeAtDate(birthDate, eventDate),
      calculateAgeAtEventDate(birthDate, eventDate),
      `checkout e importação divergiram para nascimento=${birthDate} evento=${eventDate}`,
    );
  }
});

// ============================================================
// A idade mínima em si (events.min_age) é configurável por evento -- não
// pode existir nenhum "18" fixo em lugar nenhum. Checkout
// (isMinimumAgeSatisfied, src/app/inscricao/actions.ts) e importações
// (comparação manual com eventRules.minAge, src/app/importacoes/actions.ts,
// linha a linha replicada abaixo) precisam decidir exatamente igual para
// qualquer min_age configurado -- não só 18.
// ============================================================

// Replica fielmente a decisão de bloqueio da linha de importação (ver
// src/app/importacoes/actions.ts): mesma função canônica, mesma comparação,
// só para provar equivalência sem importar um arquivo 'use server'.
function importDecisionBlocksRow(birthDate, eventStartsAt, minAge) {
  if (!eventStartsAt) return minAge > 0; // "Evento sem data de inicio para validar maioridade"
  const ageAtEvent = calculateAgeAtEventDate(birthDate, eventStartsAt);
  if (ageAtEvent === null) return null; // "Nascimento invalido ou posterior a data do evento" -- não é decisão de idade
  return minAge > 0 && ageAtEvent < minAge;
}

test('min_age=18: 17 anos no evento bloqueia, 18 permite -- checkout e importação concordam', () => {
  const eventDate = '2026-10-10';
  assert.equal(isMinimumAgeSatisfied('2008-10-11', eventDate, 18), false);
  assert.equal(importDecisionBlocksRow('2008-10-11', eventDate, 18), true);
  assert.equal(isMinimumAgeSatisfied('2008-10-10', eventDate, 18), true);
  assert.equal(importDecisionBlocksRow('2008-10-10', eventDate, 18), false);
});

test('min_age=21: 20 anos no evento bloqueia, 21 permite -- checkout e importação concordam', () => {
  const eventDate = '2026-10-10';
  assert.equal(isMinimumAgeSatisfied('2005-10-11', eventDate, 21), false, '20 anos no dia do evento, exige 21');
  assert.equal(importDecisionBlocksRow('2005-10-11', eventDate, 21), true);
  assert.equal(isMinimumAgeSatisfied('2005-10-10', eventDate, 21), true, 'completa 21 exatamente no dia do evento');
  assert.equal(importDecisionBlocksRow('2005-10-10', eventDate, 21), false);
});

test('min_age=16: 17 anos no evento permite (evento mais permissivo que 18)', () => {
  const eventDate = '2026-10-10';
  assert.equal(calculateAgeAtEventDate('2009-10-09', eventDate), 17, 'pré-condição: essa pessoa tem 17 anos no dia do evento');
  assert.equal(isMinimumAgeSatisfied('2009-10-09', eventDate, 16), true, '17 anos completos, evento exige só 16');
  assert.equal(importDecisionBlocksRow('2009-10-09', eventDate, 16), false);
});

test('sem min_age (0 ou null) nunca bloqueia por idade, qualquer que seja o nascimento', () => {
  const eventDate = '2026-10-10';
  assert.equal(isMinimumAgeSatisfied('2020-01-01', eventDate, 0), true, 'criança de 6 anos, evento sem restrição de idade');
  assert.equal(importDecisionBlocksRow('2020-01-01', eventDate, 0), false);
  assert.equal(isMinimumAgeSatisfied('2020-01-01', null, 0), true, 'sem min_age nem exige starts_at válido');
  assert.equal(importDecisionBlocksRow('2020-01-01', null, 0), false);
});

test('checkout e importação concordam para uma matriz de min_age × idade real, não só 18', () => {
  const eventDate = '2026-10-10';
  const minAges = [0, 1, 16, 18, 21, 65];
  const birthDates = ['2008-10-09', '2008-10-10', '2008-10-11', '2005-10-10', '1960-01-01'];
  for (const minAge of minAges) {
    for (const birthDate of birthDates) {
      const checkoutSatisfied = isMinimumAgeSatisfied(birthDate, eventDate, minAge);
      const importBlocked = importDecisionBlocksRow(birthDate, eventDate, minAge);
      assert.equal(
        checkoutSatisfied,
        !importBlocked,
        `min_age=${minAge} nascimento=${birthDate}: checkout satisfied=${checkoutSatisfied}, import blocked=${importBlocked}`,
      );
    }
  }
});
