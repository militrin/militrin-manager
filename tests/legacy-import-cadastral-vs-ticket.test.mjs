import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateFirstAccessProfile } from '../src/lib/account/first-access-validation.ts';
import { classifyCurrentEventPurchase } from '../src/lib/imports/classify-current-event-purchase.ts';
import {
  classifyLegacyImportBirthDateIssue,
  collectLegacyImportPersonalIssues,
  shouldPersistImportedBirthDate,
} from '../src/lib/imports/legacy-cadastral.ts';
import {
  normalizePhone,
  stripUnequivocalExcelNumericArtifact,
} from '../src/lib/imports/normalization.ts';
import { hasTicketBlockingIssues } from '../src/lib/imports/import-row-validation.ts';
import { calculateAgeAtEventDate } from '../src/lib/utils/date.ts';

const EVENT_STARTS = '2026-10-10T10:00:00+00:00';

function makeCpf(base9) {
  const digits = String(base9).padStart(9, '0').slice(-9).split('').map(Number);
  const check = (position) => {
    const factor = position + 1;
    const sum = digits.slice(0, position).reduce((total, digit, index) => total + digit * (factor - index), 0);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  digits.push(check(9));
  digits.push(check(10));
  return digits.join('');
}

test('DOB ausente nao bloqueia ingresso legado e nao e persistida', () => {
  const issue = classifyLegacyImportBirthDateIssue({
    birthDateInput: '',
    birthDate: null,
    eventStartsAt: EVENT_STARTS,
    minAge: 18,
  });
  assert.equal(issue?.issue_type, 'missing_required_age');
  assert.equal(issue?.blocks_ticket_issuance, false);
  assert.equal(issue?.resolution_scope, 'user_resolvable');
  assert.equal(hasTicketBlockingIssues([issue]), false);
  assert.equal(shouldPersistImportedBirthDate([issue], null), null);
});

test('DOB 2026 e invalida/implausivel, nao menor real, nao bloqueia ticket', () => {
  assert.equal(calculateAgeAtEventDate('2026-07-24', EVENT_STARTS), 0);
  const issue = classifyLegacyImportBirthDateIssue({
    birthDateInput: '24/07/2026',
    birthDate: '2026-07-24',
    eventStartsAt: EVENT_STARTS,
    minAge: 18,
  });
  assert.equal(issue?.issue_type, 'implausible_birth_date');
  assert.equal(issue?.blocks_ticket_issuance, false);
  assert.notEqual(issue?.issue_type, 'underage_at_event');
  assert.equal(shouldPersistImportedBirthDate([issue], '2026-07-24'), null);
});

test('DOB plausivel menor registra underage operacional sem bloquear emissao', () => {
  const issue = classifyLegacyImportBirthDateIssue({
    birthDateInput: '10/10/2010',
    birthDate: '2010-10-10',
    eventStartsAt: EVENT_STARTS,
    minAge: 18,
  });
  assert.equal(issue?.issue_type, 'underage_at_event');
  assert.equal(issue?.blocks_ticket_issuance, false);
  assert.equal(issue?.blocks_checkin, true);
  assert.equal(shouldPersistImportedBirthDate([issue], '2010-10-10'), '2010-10-10');
});

test('CPF excel sem colisao materializa compra com identidade pendente', () => {
  const leadingZeroCpf = makeCpf('012345678');
  const classified = classifyCurrentEventPurchase({
    cpfInput: leadingZeroCpf.slice(1),
    cpfCellKind: 'number',
    email: 'ana@example.com',
    cpfMatch: null,
    emailMatch: null,
    nameMatch: null,
    excelCandidateMatch: null,
    sourceFileHash: 'abc',
    occurrenceIndex: 1,
    existingSameEventPurchases: [],
  });
  assert.equal(classified.status, 'data_pending');
  assert.equal(classified.resolution, 'create_new');
  assert.equal(classified.identityMatchDetails.reason, 'create_new');
  assert.equal(classified.identityIssues[0].issue_type, 'excel_leading_zero');
  assert.equal(classified.identityIssues[0].blocks_ticket_issuance, false);
});

test('CPF excel com candidato existente exige review e nao atribui automaticamente', () => {
  const leadingZeroCpf = makeCpf('012345678');
  const classified = classifyCurrentEventPurchase({
    cpfInput: leadingZeroCpf.slice(1),
    cpfCellKind: 'number',
    email: 'ana@example.com',
    cpfMatch: null,
    emailMatch: null,
    nameMatch: null,
    excelCandidateMatch: {
      registration_contact_id: 'existing-contact',
      full_name: 'Outra Pessoa',
      cpf: leadingZeroCpf,
      reason: 'excel_cpf_candidate',
    },
    sourceFileHash: 'abc',
    occurrenceIndex: 1,
    existingSameEventPurchases: [],
  });
  assert.equal(classified.status, 'review_required');
  assert.equal(classified.resolution, 'pending');
  assert.equal(classified.identityMatchDetails.reason, 'excel_leading_zero');
  assert.equal(classified.identityMatchDetails.collision, true);
});

test('coleta cadastral do import legado nunca marca DOB/CPF como blocker comercial', () => {
  const issues = collectLegacyImportPersonalIssues({
    cpfInput: '0568452402',
    cpfCellKind: 'number',
    birthDateInput: '24/07/2026',
    birthDate: '2026-07-24',
    eventStartsAt: EVENT_STARTS,
    minAge: 18,
  });
  assert.equal(hasTicketBlockingIssues(issues), false);
  assert.ok(issues.some((issue) => issue.issue_type === 'excel_leading_zero' || issue.issue_type === 'invalid_identity'));
  assert.ok(issues.some((issue) => issue.issue_type === 'implausible_birth_date'));
});

test('primeiro acesso rejeita DOB evidentemente invalida como ano corrente', () => {
  const year = new Date().getFullYear();
  const result = validateFirstAccessProfile({
    full_name: 'Eduardo Dill Bernardo',
    cpf: '529.982.247-25',
    birth_date: `24/07/${year}`,
    gender: 'male',
    phone: '49999999999',
    email: 'eduardo@example.com',
    city: 'Itapiranga',
  });
  assert.equal(result.success, false);
  assert.equal(result.fieldErrors.birth_date, 'Informe uma data de nascimento válida.');
});

test('telefone .0 do Excel e normalizado; 12 digitos sem ponto nao sao inventados', () => {
  assert.equal(stripUnequivocalExcelNumericArtifact('54999999999.0'), '54999999999');
  assert.equal(stripUnequivocalExcelNumericArtifact('54999999999.00'), '54999999999');
  assert.equal(stripUnequivocalExcelNumericArtifact('5499999999,0'), '5499999999');
  assert.equal(normalizePhone('54999999999.0'), '54999999999');
  assert.equal(normalizePhone('54999999999.000'), '54999999999');
  assert.equal(normalizePhone('(54) 99999-9999'), '54999999999');
  assert.equal(normalizePhone('549999999990'), '549999999990');
  assert.notEqual(normalizePhone('5.4999999999e+10'), '54999999999');
  const issues = collectLegacyImportPersonalIssues({
    cpfInput: makeCpf('529982247'),
    phoneInput: '54999999999.0',
    phone: normalizePhone('54999999999.0'),
    birthDateInput: '10/10/1990',
    birthDate: '1990-10-10',
    eventStartsAt: EVENT_STARTS,
    minAge: 18,
  });
  assert.equal(issues.some((issue) => issue.field_code === 'phone'), false);
});

test('checkout publico continua exigindo idade minima; SQL reevaluate nao bloqueia ticket cadastral', async () => {
  const inscricao = await readFile(new URL('../src/app/inscricao/actions.ts', import.meta.url), 'utf8');
  const reevaluate = await readFile(new URL('../supabase/migrations/20261008000000_legacy_import_ticket_vs_cadastral.sql', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../src/app/importacoes/actions.ts', import.meta.url), 'utf8');
  assert.match(inscricao, /isMinimumAgeSatisfied/);
  assert.match(reevaluate, /implausible_birth_date/);
  assert.match(reevaluate, /user_resolvable/);
  assert.match(actions, /collectLegacyImportPersonalIssues/);
  assert.match(actions, /shouldPersistImportedBirthDate/);
  const cpfInsert = reevaluate.slice(reevaluate.indexOf("values('cpf','missing_required_identity'"), reevaluate.indexOf("values('cpf','invalid_identity'"));
  assert.match(cpfInsert, /false,false,false,false,'user_resolvable'/);
});
