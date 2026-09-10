import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolvePricingPreviewGender } from '../src/lib/checkout/pricing.ts';
import {
  formatImportedHistoricalAmount,
  importShouldCreatePricingGenderIssue,
  resolveLegacyImportPrice,
} from '../src/lib/imports/legacy-price.ts';
import { normalizeImportedPaymentMethod } from '../src/lib/imports/payment-method.ts';
import { normalizeImportedShirtType } from '../src/lib/imports/shirt-type.ts';
import { classifyCurrentEventPurchase } from '../src/lib/imports/classify-current-event-purchase.ts';
import { calculateAgeAtEventDate } from '../src/lib/utils/date.ts';
import { hasTicketBlockingIssues, isValidCpf } from '../src/lib/imports/import-row-validation.ts';

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

const leadingZeroCpf = makeCpf('012345678');
assert.equal(isValidCpf(leadingZeroCpf), true);

const actions = await readFile(new URL('../src/app/importacoes/actions.ts', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20260957000000_legacy_import_unknown_price.sql', import.meta.url), 'utf8');
const settlement = await readFile(new URL('../supabase/migrations/20261017000000_legacy_paid_operational_payment.sql', import.meta.url), 'utf8');
const importRpc = migration.match(/create or replace function public\.import_current_event_contact_first[\s\S]*?end; \$\$;/)?.[0] ?? '';
const finalizer = settlement.match(/create or replace function public\.finalize_imported_ticket_after_issue_resolution[\s\S]*?end; \$\$;/)?.[0] ?? '';
const confirmer = migration.match(/create or replace function public\.confirm_order_item_and_issue_ticket[\s\S]*?end; \$\$;/)?.[0] ?? '';
const reevaluate = migration.match(/create or replace function public\.reevaluate_participant_data_issues[\s\S]*?end; \$_\$;/)?.[0] ?? '';
const resolveIssues = migration.match(/create or replace function public\.resolve_ticket_data_issues[\s\S]*?end; \$\$;/)?.[0] ?? '';

test('venda nova: precos M/F diferentes com genero vazio continuam bloqueando preview', () => {
  assert.equal(resolvePricingPreviewGender({}, { malePrice: 200, femalePrice: 170 }), null);
  assert.equal(resolvePricingPreviewGender({ buyerGender: 'male' }, { malePrice: 200, femalePrice: 170 }), 'male');
});

test('import legado sem preco: malePrice != femalePrice e gender vazio nao cria missing_required_for_pricing', () => {
  assert.equal(importShouldCreatePricingGenderIssue({
    amount: null,
    malePrice: 200,
    femalePrice: 170,
    gender: null,
  }), false);
  assert.match(actions, /importShouldCreatePricingGenderIssue/);
  assert.match(actions, /!isLegacyImportPriceOrigin\(row\.price_origin\)/);
  assert.doesNotMatch(actions, /price\.malePrice !== price\.femalePrice && !row\.gender/);
});

test('import legado sem preco nao inventa catalogo nem trata 0 como gratuito', () => {
  assert.deepEqual(resolveLegacyImportPrice(null), {
    priceOrigin: 'legacy_unknown',
    legacyPriceStatus: 'unknown',
    amount: null,
  });
  assert.equal(formatImportedHistoricalAmount(0, 'legacy_unknown'), 'Não informado');
  assert.doesNotMatch(importRpc, /registration_batch_prices/);
  assert.match(importRpc, /v_price_origin = 'legacy_unknown'/);
  assert.match(importRpc, /v_amount := 0;/);
  assert.match(migration, /nunca[\s\S]*cortesia/);
});

test('import legado nao cria cobranca Asaas nem receita financeira', () => {
  assert.doesNotMatch(importRpc, /asaas|financial_entries/i);
  assert.match(importRpc, /payment_status,price_origin\)[\s\S]*'pending'/);
  assert.doesNotMatch(finalizer, /asaas/i);
  assert.match(finalizer, /legacy_unknown_ticket_issued/);
  const unknownBranch = finalizer.slice(finalizer.indexOf('elsif v_legacy_unknown then'), finalizer.indexOf("v_finalization:='payment_pending'"));
  assert.match(unknownBranch, /payment_status='paid'/);
  assert.doesNotMatch(unknownBranch, /payment_method=/);
  assert.doesNotMatch(unknownBranch, /amount=/);
  assert.doesNotMatch(unknownBranch, /gateway_payment_id=/);
});

test('import legado sem blocker real pode emitir ticket sem pagamento pago', () => {
  assert.match(confirmer, /v_legacy_unknown := public\.is_legacy_import_unknown_price/);
  assert.match(confirmer, /if v_payment\.payment_status<>'paid' and not v_legacy_unknown then/);
  assert.match(finalizer, /confirm_order_item_and_issue_ticket/);
  assert.match(actions, /if \(!hasBlockingDataIssues\) \{/);
});

test('underage evidente/invalido no import legado nao bloqueia ticket', () => {
  const age = calculateAgeAtEventDate('2026-07-25', '2026-10-10T12:00:00-03:00');
  assert.equal(age, 0);
  assert.match(actions, /collectLegacyImportPersonalIssues/);
  const issues = [{
    field_code: 'birth_date',
    issue_type: 'implausible_birth_date',
    message: 'Data de nascimento importada e evidentemente invalida.',
    blocks_payment: false,
    blocks_ticket_issuance: false,
    blocks_checkin: false,
    blocks_kit_delivery: false,
  }];
  assert.equal(hasTicketBlockingIssues(issues), false);
});

test('CPF invalido preserva compra e segue review/identidade existente', () => {
  const classified = classifyCurrentEventPurchase({
    cpfInput: '033363327005',
    cpfCellKind: 'text',
    email: 'jonas@example.com',
    cpfMatch: null,
    emailMatch: null,
    nameMatch: null,
    sourceFileHash: 'abc',
    occurrenceIndex: 1,
    existingSameEventPurchases: [],
  });
  assert.equal(classified.status, 'data_pending');
  assert.equal(classified.resolution, 'create_new');
  assert.ok(classified.identityIssues.some((issue) => issue.issue_type === 'invalid_identity'));
  assert.equal(classified.identityIssues[0].blocks_ticket_issuance, false);
});

test('excel leading zero sem colisao preserva compra e nao inventa identidade', () => {
  const classified = classifyCurrentEventPurchase({
    cpfInput: leadingZeroCpf.slice(1),
    cpfCellKind: 'number',
    email: 'row180@example.com',
    cpfMatch: null,
    emailMatch: null,
    nameMatch: null,
    sourceFileHash: 'abc',
    occurrenceIndex: 1,
    existingSameEventPurchases: [],
  });
  assert.equal(classified.status, 'data_pending');
  assert.equal(classified.resolution, 'create_new');
  assert.equal(classified.identityIssues[0].issue_type, 'excel_leading_zero');
  assert.equal(classified.identityIssues[0].blocks_ticket_issuance, false);
});

test('reevaluate e resolucao nao recriam pricing de genero nem sobrescrevem preco legado', () => {
  assert.match(reevaluate, /not v_legacy_historical/);
  assert.match(reevaluate, /is_legacy_import_historical_price/);
  assert.match(resolveIssues, /not public\.is_legacy_import_historical_price/);
});

test('normalizePaymentMethod aceita Cartao com acento, caixa e espacos sem inventar status', () => {
  assert.equal(normalizeImportedPaymentMethod('Cartão'), 'credit_card');
  assert.equal(normalizeImportedPaymentMethod('Cartao'), 'credit_card');
  assert.equal(normalizeImportedPaymentMethod('CARTÃO'), 'credit_card');
  assert.equal(normalizeImportedPaymentMethod('  Cartão  '), 'credit_card');
  assert.equal(normalizeImportedPaymentMethod('Pix'), 'pix');
  assert.equal(normalizeImportedPaymentMethod(''), null);
  assert.match(actions, /normalizeImportedPaymentMethod/);
  assert.doesNotMatch(actions, /payment_status.*=.*normalizeImportedPaymentMethod/);
  assert.doesNotMatch(actions, /normalized\.payment_method \?\? 'pix'/);
});

test('Tipo Babylook/Camiseta mapeia camiseta e nao infere genero', () => {
  assert.equal(normalizeImportedShirtType('Babylook'), 'Babylook');
  assert.equal(normalizeImportedShirtType('Camiseta'), 'Camiseta');
  assert.doesNotMatch(actions, /Babylook[\s\S]{0,80}female|Camiseta[\s\S]{0,80}male/);
});
