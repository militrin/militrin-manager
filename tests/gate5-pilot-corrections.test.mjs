import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { resolveBuyerPresentation } from '../src/lib/dashboard/commercial-status.ts';
import {
  formatImportedHistoricalAmount,
  isLegacyUnknownPriceOrigin,
  shouldIncludeAmountInFinancialTotals,
} from '../src/lib/imports/legacy-price.ts';
import {
  formatImportedPaymentMethod,
  normalizeImportedPaymentMethod,
} from '../src/lib/imports/payment-method.ts';
import {
  additionalTicketHolderUnassignedCopy,
  countIssuedTickets,
  formatImportedPurchaseWithoutTicketCopy,
  formatIssuanceBlockerMessages,
  openIssuanceBlockers,
} from '../src/lib/imports/issuance-presentation.ts';
import {
  isPendingImportIdentityReview,
  isSharedEmailOwnershipReview,
  resolveSharedEmailReviewAfterMaterialization,
} from '../src/lib/imports/identity-review.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [
  actions,
  latestMigration,
  financeiroPage,
  pedidoPage,
  cadastroPage,
  revisoesPage,
  pedidosActions,
] = await Promise.all([
  read('src/app/importacoes/actions.ts'),
  read('supabase/migrations/20261005000000_gate5_pilot_payment_method_and_review.sql'),
  read('src/app/financeiro/page.tsx'),
  read('src/app/inscricoes/pedido/[orderId]/page.tsx'),
  read('src/app/cadastros/[id]/page.tsx'),
  read('src/app/importacoes/revisoes/page.tsx'),
  read('src/app/pedidos/actions.ts'),
]);

const importRpc = latestMigration.match(/create or replace function public\.import_current_event_contact_first[\s\S]*?end; \$\$;/)?.[0] ?? '';

test('1. legacy_unknown + amount=0 mostra Não informado, nunca R$ 0,00', () => {
  assert.equal(formatImportedHistoricalAmount(0, 'legacy_unknown'), 'Não informado');
  assert.equal(formatImportedHistoricalAmount(0.0, 'legacy_unknown'), 'Não informado');
  assert.equal(isLegacyUnknownPriceOrigin('legacy_unknown'), true);
  assert.equal(shouldIncludeAmountInFinancialTotals('legacy_unknown'), false);
  assert.match(financeiroPage, /formatImportedHistoricalAmount\(row\.final_amount, row\.price_origin\)/);
  assert.doesNotMatch(financeiroPage, /R\$ \{Number\(row\.final_amount\)\.toFixed\(2\)\}/);
});

test('2. preço real conhecido igual a 0 não é legacy_unknown', () => {
  assert.match(formatImportedHistoricalAmount(0, 'catalog'), /R\$\s*0,00/);
  assert.match(formatImportedHistoricalAmount(0, 'legacy_provided'), /R\$\s*0,00/);
  assert.equal(shouldIncludeAmountInFinancialTotals('catalog'), true);
  assert.equal(shouldIncludeAmountInFinancialTotals('legacy_provided'), true);
  assert.equal(isLegacyUnknownPriceOrigin('catalog'), false);
  assert.equal(isLegacyUnknownPriceOrigin('legacy_provided'), false);
});

test('3. cortesia real continua Cortesia', () => {
  const courtesy = resolveBuyerPresentation({
    buyerType: 'administrative',
    holderName: 'Maria Cortesia',
    paymentMethod: 'courtesy',
  });
  assert.equal(courtesy.isCourtesy, true);
  assert.equal(courtesy.label, 'Destinatário');
  assert.match(courtesy.name, /Cortesia/);
  assert.equal(formatImportedPaymentMethod('courtesy'), 'Cortesia');
  assert.equal(normalizeImportedPaymentMethod('Cortesia'), 'courtesy');
});

test('3b. administrative sem payment_method courtesy não é Cortesia', () => {
  const paidByOperator = resolveBuyerPresentation({
    buyerType: 'administrative',
    holderName: 'João Operador',
    paymentMethod: 'pix',
  });
  assert.equal(paidByOperator.isCourtesy, false);
  assert.equal(paidByOperator.label, 'Destinatário');
  assert.equal(paidByOperator.name, 'João Operador');
  assert.doesNotMatch(paidByOperator.name, /Cortesia/);

  const cash = resolveBuyerPresentation({
    buyerType: 'administrative',
    holderName: 'Ana Dinheiro',
    paymentMethod: 'cash',
  });
  assert.equal(cash.isCourtesy, false);
  assert.doesNotMatch(cash.name, /Cortesia/);

  const unnamed = resolveBuyerPresentation({ buyerType: 'administrative', paymentMethod: 'pix' });
  assert.equal(unnamed.isCourtesy, false);
  assert.equal(unnamed.label, 'Destinatário');
  assert.doesNotMatch(unnamed.name, /Cortesia/);
});

test('4. imported_holder não implica Cortesia', () => {
  const imported = resolveBuyerPresentation({
    buyerType: 'imported_holder',
    holderName: 'Jonas Volpatto Sponchiado',
    paymentMethod: null,
  });
  assert.equal(imported.isCourtesy, false);
  assert.equal(imported.label, 'Destinatário');
  assert.equal(imported.name, 'Jonas Volpatto Sponchiado');
  assert.doesNotMatch(imported.name, /Cortesia/);
  const unnamed = resolveBuyerPresentation({ buyerType: 'imported_holder', paymentMethod: 'pix' });
  assert.equal(unnamed.isCourtesy, false);
  assert.doesNotMatch(unnamed.name, /Cortesia/);
});

test('5. order com item mas sem ticket conta ingressos emitidos, não itens', () => {
  assert.equal(countIssuedTickets([
    { ticketId: null, ticketStatus: null },
    { ticketId: 't1', ticketStatus: 'active' },
    { ticketId: 't2', ticketStatus: 'cancelled' },
  ]), 1);
  assert.match(pedidosActions, /countIssuedTickets\(items\)/);
  assert.match(pedidoPage, /ingressos emitidos/);
  assert.match(pedidoPage, /ticketItems\.length === 1 \? "inscrição"/);
});

test('6. underage_at_event aparece como blocker de emissão em Pedido e Cadastro', () => {
  const messages = formatIssuanceBlockerMessages([{
    issue_type: 'underage_at_event',
    message: 'Pessoa menor de 18 anos na data do evento.',
    blocks_ticket_issuance: true,
    status: 'open',
  }]);
  assert.deepEqual(messages, ['Pessoa menor de 18 anos na data do evento.']);
  assert.match(cadastroPage, /formatImportedPurchaseWithoutTicketCopy/);
  assert.match(pedidoPage, /formatIssuanceBlockerMessages/);
  assert.match(pedidoPage, /blockedIssuance/);
});

test('7. legacy_unknown não é issuance blocker', () => {
  const blockers = openIssuanceBlockers([
    { issue_type: 'legacy_unknown', message: 'preço histórico não informado', blocks_ticket_issuance: true, status: 'open' },
    { issue_type: 'underage_at_event', message: 'Pessoa menor de 18 anos na data do evento.', blocks_ticket_issuance: true, status: 'open' },
  ]);
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].issue_type, 'underage_at_event');
  const copy = formatImportedPurchaseWithoutTicketCopy({ eventName: 'Militrin 2026', blockerMessages: [] });
  assert.doesNotMatch(copy, /preço histórico não informado/i);
  assert.doesNotMatch(cadastroPage, /preço histórico não informado/);
});

test('8. shared email + CPFs distintos não oferece merge após materialização', () => {
  assert.equal(isPendingImportIdentityReview({
    status: 'imported',
    resolution: 'create_new',
    identity_match_details: { account_review: 'shared_email' },
  }), false);
  assert.equal(isPendingImportIdentityReview({
    status: 'review_required',
    resolution: 'pending',
    identity_match_details: { reason: 'excel_leading_zero' },
  }), true);
  assert.equal(isSharedEmailOwnershipReview({ account_review: 'shared_email' }), true);
  const resolved = resolveSharedEmailReviewAfterMaterialization({ account_review: 'shared_email' });
  assert.equal(resolved.account_review_resolved, 'materialized_distinct_identities');
  assert.match(revisoesPage, /isPendingImportIdentityReview/);
  assert.match(revisoesPage, /isOwnershipReview/);
  assert.match(actions, /resolveSharedEmailReviewAfterMaterialization/);
});

test('9. múltiplos tickets da mesma pessoa respeitam titularidade existente', () => {
  assert.match(importRpc, /v_assign_holder:=false/);
  assert.match(additionalTicketHolderUnassignedCopy(), /apenas um titular por pessoa por evento/);
  assert.match(cadastroPage, /holderUnassigned/);
  assert.match(pedidoPage, /unassignedHolder/);
});

test('10. payment_method vazio não vira pix', () => {
  assert.equal(normalizeImportedPaymentMethod(''), null);
  assert.equal(normalizeImportedPaymentMethod('   '), null);
  assert.equal(formatImportedPaymentMethod(null), 'Não informado');
  assert.equal(formatImportedPaymentMethod(''), 'Não informado');
  assert.doesNotMatch(actions, /normalized\.payment_method \?\? 'pix'/);
  assert.match(importRpc, /p_payment_method text default null/);
  assert.doesNotMatch(importRpc, /coalesce\(nullif\(trim\(p_payment_method\),''\),'pix'\)/);
  assert.match(latestMigration, /payment_method = null/);
  assert.match(latestMigration, /e0e3602c09c3d9b8ab009b58cc8701389b4538b9640241312a8d346af685365e/);
});

test('11. Pix vira pix', () => {
  assert.equal(normalizeImportedPaymentMethod('Pix'), 'pix');
  assert.equal(normalizeImportedPaymentMethod('PIX'), 'pix');
  assert.equal(formatImportedPaymentMethod('pix'), 'PIX');
});

test('12. Cartão/Cartao/CARTÃO vira credit_card', () => {
  assert.equal(normalizeImportedPaymentMethod('Cartão'), 'credit_card');
  assert.equal(normalizeImportedPaymentMethod('Cartao'), 'credit_card');
  assert.equal(normalizeImportedPaymentMethod('CARTÃO'), 'credit_card');
  assert.equal(formatImportedPaymentMethod('credit_card'), 'Cartão');
});

test('13. método conhecido + import legado não cria charge Asaas', () => {
  assert.doesNotMatch(importRpc, /asaas|financial_entries/i);
  assert.match(importRpc, /'pending',v_price_origin/);
  assert.match(latestMigration, /p\.gateway_payment_id is null/);
});
