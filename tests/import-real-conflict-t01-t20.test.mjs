import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { classifyImportedCpf } from '../src/lib/imports/cpf-excel.ts';
import { isValidCpf } from '../src/lib/imports/import-row-validation.ts';
import {
  assignOccurrenceIndexes,
  buildPurchaseFingerprint,
  hashSourceFileBytes,
  purchaseOccurrenceKey,
} from '../src/lib/imports/purchase-identity.ts';
import { normalizeImportedShirtType } from '../src/lib/imports/shirt-type.ts';
import {
  classifyCurrentEventPurchase,
  classifyIntraFileSharedEmails,
} from '../src/lib/imports/classify-current-event-purchase.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

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

const douglasCpf = makeCpf('529982247');
const joaoCpf = makeCpf('111444777');
const mariaCpf = makeCpf('390533447');
const pedroCpf = makeCpf('853513468');
const leadingZeroCpf = makeCpf('012345678');
assert.equal(isValidCpf(douglasCpf), true);
assert.equal(leadingZeroCpf.startsWith('0'), true);
assert.equal(isValidCpf(leadingZeroCpf), true);

const person = (id, extra = {}) => ({
  registration_contact_id: id,
  full_name: extra.full_name ?? 'Pessoa',
  cpf: extra.cpf ?? null,
  email: extra.email ?? null,
  reason: extra.reason ?? 'cpf_exact',
});

function classifyPurchase(overrides = {}) {
  return classifyCurrentEventPurchase({
    cpfInput: douglasCpf,
    email: 'douglas@example.test',
    cpfMatch: null,
    emailMatch: null,
    nameMatch: null,
    sourceFileHash: 'file-a',
    occurrenceIndex: 1,
    existingSameEventPurchases: [],
    ...overrides,
  });
}

const [
  actions,
  client,
  reviewQueue,
  firstAccess,
  shirtType,
  parseFile,
  migration,
  gate2,
] = await Promise.all([
  read('src/app/importacoes/actions.ts'),
  read('src/app/importacoes/ImportacoesClient.tsx'),
  read('src/app/importacoes/revisoes/page.tsx'),
  read('src/app/primeiro-acesso/actions.ts'),
  read('src/lib/imports/shirt-type.ts'),
  read('src/lib/imports/parse-file.ts'),
  read('supabase/migrations/20260949000000_import_real_purchase_ownership.sql'),
  read('tests/release-gate2-p0-identity-security.integration.mjs'),
]);

test('T01 Pessoa unica normal fica pronta para criar', () => {
  const result = classifyPurchase();
  assert.equal(result.status, 'ready');
  assert.equal(result.resolution, 'create_new');
  assert.equal(result.additionalPurchase, false);
  assert.equal(result.identityMatchDetails.reason, 'create_new');
});

test('T02 CPF com zero inicial como texto permanece valido sem pad', () => {
  const classified = classifyImportedCpf(leadingZeroCpf, 'text');
  assert.equal(classified.kind, 'valid');
  assert.equal(classified.canonical, leadingZeroCpf);
  assert.equal(classified.excelCandidate, null);
  const result = classifyPurchase({ cpfInput: leadingZeroCpf });
  assert.equal(result.status, 'ready');
  assert.equal(result.resolution, 'create_new');
});

test('T03 CPF com zero perdido gera revisao e nunca autopad', () => {
  const original = leadingZeroCpf.slice(1);
  assert.equal(original.length, 10);
  const classified = classifyImportedCpf(original, 'number');
  assert.equal(classified.kind, 'excel_leading_zero');
  assert.equal(classified.canonical, null);
  assert.equal(classified.excelCandidate, leadingZeroCpf);
  const result = classifyPurchase({ cpfInput: original, cpfCellKind: 'number' });
  assert.equal(result.status, 'review_required');
  assert.equal(result.identityMatchDetails.reason, 'excel_leading_zero');
  assert.match(actions, /excel_cpf_candidate/);
  assert.doesNotMatch(actions, /padStart\(11,\s*'0'\)/);
  assert.match(reviewQueue, /Confirmar CPF sugerido/);
  assert.match(reviewQueue, /Manter como CPF pendente/);
});

test('T04 CPF invalido preserva compra com identidade pendente', () => {
  const result = classifyPurchase({ cpfInput: '12345678900' });
  assert.equal(result.status, 'data_pending');
  assert.equal(result.resolution, 'create_new');
  assert.equal(result.identityIssues[0].blocks_ticket_issuance, false);
  assert.equal(result.identityIssues[0].blocks_payment, false);
  assert.equal(result.identityIssues[0].resolution_scope, 'user_resolvable');
  assert.match(migration, /case when public\.is_valid_cpf\(v_cpf\) then v_cpf end/);
  assert.match(firstAccess, /assert_registration_contact_cpf_available/);
});

test('T05 mesmo CPF\/e-mail, 2 compras, camisetas diferentes', () => {
  const first = classifyPurchase();
  const second = classifyPurchase({
    cpfMatch: person('contact-douglas', { cpf: douglasCpf, email: 'douglas@example.test' }),
  });
  assert.equal(first.resolution, 'create_new');
  assert.equal(second.resolution, 'link_existing');
  assert.equal(second.additionalPurchase, true);
  assert.match(actions, /intraFileAdditionalPurchase/);
  assert.match(migration, /v_contact\.id,v_intended/);
  assert.doesNotMatch(migration, /case when v_assign_holder then v_contact\.id end/);
});

test('T06 mesmo CPF, 3 compras continuam 3 compras', () => {
  const fingerprints = [
    buildPurchaseFingerprint({ fullName: 'Douglas', cpfInput: douglasCpf, shirtSize: 'M' }),
    buildPurchaseFingerprint({ fullName: 'Douglas', cpfInput: douglasCpf, shirtSize: 'G' }),
    buildPurchaseFingerprint({ fullName: 'Douglas', cpfInput: douglasCpf, shirtSize: 'GG' }),
  ];
  assert.equal(new Set(fingerprints).size, 3);
  const third = classifyPurchase({
    cpfMatch: person('contact-douglas', { cpf: douglasCpf }),
    occurrenceIndex: 3,
  });
  assert.equal(third.additionalPurchase, true);
  assert.equal(third.status, 'ready');
});

test('T07 mesmo e-mail, CPFs diferentes permanecem Pessoas separadas', () => {
  const result = classifyPurchase({
    cpfInput: mariaCpf,
    email: 'familia@gmail.com',
    emailMatch: person('contact-joao', { cpf: joaoCpf, email: 'familia@gmail.com', reason: 'email_exact' }),
  });
  assert.equal(result.resolution, 'create_new');
  assert.equal(result.identityMatchDetails.account_review, 'shared_email');
  assert.notEqual(result.status, 'review_required');
});

test('T08 nomes diferentes + mesmo e-mail geram revisao de conta, nao fusao', () => {
  const shared = classifyIntraFileSharedEmails([
    { email: 'familia@gmail.com', cpf: joaoCpf, index: 0 },
    { email: 'familia@gmail.com', cpf: mariaCpf, index: 1 },
    { email: 'familia@gmail.com', cpf: pedroCpf, index: 2 },
  ]);
  assert.deepEqual([...shared].sort(), [0, 1, 2]);
  assert.match(actions, /account_review: 'shared_email'/);
  assert.match(reviewQueue, /Manter Pessoas separadas/);
});

test('T09 manter Pessoas separadas e decisao administrativa explicita', () => {
  assert.match(migration, /keep_people_separate/);
  assert.match(reviewQueue, /decision" value="keep_people_separate"/);
  assert.match(migration, /import_people_kept_separate/);
});

test('T10 admin escolhe Maria como conta proprietaria sem fundir identidades', () => {
  assert.match(migration, /assign_owner_contact/);
  assert.match(migration, /intended_owner_contact_id=v_owner/);
  assert.match(reviewQueue, /Usar esta Pessoa como conta dos ingressos/);
  assert.match(migration, /raise exception 'Sem permissao para definir a conta proprietaria.'/);
  assert.doesNotMatch(migration, /update public\.registration_contacts[\s\S]{0,80}set cpf=/);
});

test('T11 claim da Maria materializa owner_user_id dos tickets destinados a ela', () => {
  assert.match(migration, /materialize_intended_ticket_owners_for_contact/);
  assert.match(migration, /perform public\.materialize_intended_ticket_owners_for_contact\(new\.id,new\.user_id\)/);
  assert.match(migration, /where t\.intended_owner_contact_id=p_contact_id/);
  assert.match(migration, /and t\.owner_user_id is null/);
});

test('T12 multiplos ingressos preservam camisetas diferentes', () => {
  const m = buildPurchaseFingerprint({ fullName: 'Douglas', cpfInput: douglasCpf, shirtType: 'Camiseta', shirtSize: 'M' });
  const gg = buildPurchaseFingerprint({ fullName: 'Douglas', cpfInput: douglasCpf, shirtType: 'Camiseta', shirtSize: 'GG' });
  assert.notEqual(m, gg);
  assert.match(migration, /'shirt_type',p_shirt_type,'shirt_size',p_shirt_size/);
});

test('T13 Camiseta + Babylook nao altera genero da Pessoa', () => {
  assert.equal(normalizeImportedShirtType('Babylook'), 'Babylook');
  assert.equal(normalizeImportedShirtType('Camiseta'), 'Camiseta');
  assert.match(shirtType, /return 'Babylook'/);
  assert.match(actions, /gender: importedGender/);
  assert.doesNotMatch(actions, /gender_inference/);
  assert.doesNotMatch(actions, /Babylook[\s\S]{0,40}gender\s*=/);
  assert.match(actions, /importedGender = normalizeImportedGender\(get\('gender'\)\)/);
});

test('T14 payment_mode pending permanece o padrao por compra', () => {
  assert.match(client, /useState<'pending' \| 'confirm_all'>\('pending'\)/);
  assert.match(actions, /payment_mode_original: persistedPaymentMode/);
  assert.match(migration, /insert into public\.payments/);
});

test('T15 confirm_all confirma cada compra elegivel, sem agregar', () => {
  assert.match(actions, /finalize_imported_ticket_after_issue_resolution/);
  assert.match(client, /Confirmar todos como pagos e emitir ingressos/);
  assert.match(actions, /p_payment_method: paymentMethod/);
});

test('T16 mesmo arquivo enviado novamente nao restagia', () => {
  const hash = hashSourceFileBytes(Buffer.from('Nome,CPF\nDouglas,52998224725\n'));
  assert.equal(hash.length, 64);
  assert.match(actions, /alreadyImported: true as const/);
  assert.match(client, /Este arquivo já foi importado anteriormente/);
  assert.match(client, /Revisar o lote anterior/);
});

test('T17 refresh\/retry do execute nao duplica pedido ja materializado', () => {
  assert.match(migration, /if v_row\.order_item_id is not null then/);
  assert.match(actions, /if \(row\.order_item_id\) \{\s*importedRows \+= 1;/);
  assert.match(actions, /status === 'imported'/);
});

test('T18 duas linhas identicas no mesmo arquivo sao duas compras', () => {
  const fingerprint = buildPurchaseFingerprint({
    fullName: 'Douglas',
    cpfInput: douglasCpf,
    emailInput: 'douglas@example.test',
    shirtType: 'Camiseta',
    shirtSize: 'M',
  });
  const occurrences = assignOccurrenceIndexes([fingerprint, fingerprint]);
  assert.deepEqual(occurrences, [1, 2]);
  const key1 = purchaseOccurrenceKey({ sourceFileHash: 'abc', rowFingerprint: fingerprint, occurrenceIndex: 1 });
  const key2 = purchaseOccurrenceKey({ sourceFileHash: 'abc', rowFingerprint: fingerprint, occurrenceIndex: 2 });
  assert.notEqual(key1, key2);
  assert.match(migration, /ux_import_batch_rows_purchase_occurrence/);
});

test('T19 linha igual em outro arquivo vai para revisao, nunca descarte silencioso', () => {
  const result = classifyPurchase({
    sourceFileHash: 'file-b',
    existingSameEventPurchases: [{
      importBatchRowId: 'row-1',
      sourceFileHash: 'file-a',
      occurrenceIndex: 1,
    }],
  });
  assert.equal(result.status, 'review_required');
  assert.equal(result.identityMatchDetails.reason, 'possible_reimport');
  assert.match(reviewQueue, /Esta é nova compra/);
  assert.match(reviewQueue, /Já foi importada \/ ignorar duplicação técnica/);
});

test('T20 ataques ao claim\/ownership permanecem bloqueados', () => {
  assert.match(gate2, /ATTACK/);
  assert.match(gate2, /claim_registration_contact_account_invite/);
  assert.match(gate2, /reconcile_registration_contact_account nao anexa contact orfao arbitrario/);
  assert.match(migration, /revoke all on function public\.materialize_intended_ticket_owners_for_contact\(uuid,uuid\) from public, anon, authenticated/);
  assert.match(migration, /trg_protect_intended_owner_contact/);
  assert.match(migration, /Sem permissao para alterar a intencao de proprietario/);
  assert.match(firstAccess, /assert_registration_contact_cpf_available/);
  const preClaim = firstAccess.indexOf("rpc('assert_registration_contact_cpf_available'");
  const claimAt = firstAccess.indexOf("rpc('claim_registration_contact_account_invite'");
  assert.ok(preClaim > 0 && preClaim < claimAt);
  assert.match(migration, /grant execute on function public\.assign_imported_ticket_owner_contact\(uuid\[\],uuid\) to authenticated, service_role/);
  assert.doesNotMatch(migration, /grant execute on function public\.materialize_intended_ticket_owners_for_contact\(uuid,uuid\) to authenticated/);
});

test('parser XLSX preserva representacao formatada e tipo cru da celula', () => {
  assert.match(parseFile, /raw: false/);
  assert.match(parseFile, /raw: true/);
  assert.match(parseFile, /describeCellKind/);
  assert.match(parseFile, /cellKinds/);
});
