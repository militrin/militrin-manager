import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { formatImportedHistoricalAmount } from '../src/lib/imports/legacy-price.ts';
import { resolveOperationalPaymentState } from '../src/lib/operations/payment-operational-state.ts';

const OFFICIAL_BATCH = 'aee74ffb-1eb3-4742-818f-77b701fd7da0';
const migration = await readFile(new URL('../supabase/migrations/20261017000000_legacy_paid_operational_payment.sql', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/operacoes/actions.ts', import.meta.url), 'utf8');
const row = await readFile(new URL('../src/app/operacoes/components/OperationRow.tsx', import.meta.url), 'utf8');
const details = await readFile(new URL('../src/app/operacoes/components/ExpandedTicketDetails.tsx', import.meta.url), 'utf8');
const gateway = await readFile(new URL('../tests/payment-gateway-status-and-tickets.integration.mjs', import.meta.url), 'utf8');

test('1. legacy_paid: QR operacional, Pago · Legado, entrega e check-in liberados', () => {
  const state = resolveOperationalPaymentState({
    paymentStatus: 'paid',
    paymentMethod: null,
    priceOrigin: 'legacy_unknown',
    ticketStatus: 'active',
  });
  assert.equal(state.kind, 'legacy_paid');
  assert.equal(state.label, 'Pago · Legado');
  assert.equal(state.methodLabel, 'Não informado');
  assert.equal(state.operational, true);
  assert.equal(state.blockReason, null);

  const leftoverPending = resolveOperationalPaymentState({
    paymentStatus: 'pending',
    paymentMethod: null,
    priceOrigin: 'legacy_unknown',
    ticketStatus: 'active',
  });
  assert.equal(leftoverPending.kind, 'legacy_paid');
  assert.equal(leftoverPending.operational, true);
  assert.match(migration, /ticket_has_operational_payment/);
  assert.match(row, /Pago · Legado|payment_label/);
});

test('2. Asaas paid: Pago e operação permitida', () => {
  const state = resolveOperationalPaymentState({
    paymentStatus: 'paid',
    paymentMethod: 'pix',
    priceOrigin: 'catalog',
    ticketStatus: 'active',
  });
  assert.equal(state.kind, 'paid');
  assert.equal(state.label, 'Pago');
  assert.equal(state.operational, true);
});

test('3. courtesy/admin: Cortesia e operação permitida', () => {
  const state = resolveOperationalPaymentState({
    paymentStatus: 'paid',
    paymentMethod: 'courtesy',
    priceOrigin: null,
    ticketStatus: 'active',
  });
  assert.equal(state.kind, 'courtesy');
  assert.equal(state.label, 'Cortesia');
  assert.equal(state.operational, true);
});

test('4. pending real: operação bloqueada com feedback correto', () => {
  const state = resolveOperationalPaymentState({
    paymentStatus: 'pending',
    paymentMethod: 'pix',
    priceOrigin: 'catalog',
    ticketStatus: 'active',
  });
  assert.equal(state.kind, 'pending');
  assert.equal(state.label, 'Pendente');
  assert.equal(state.operational, false);
  assert.match(state.blockReason ?? '', /Pagamento ainda não confirmado/);
  assert.match(details, /payment_kind === "pending"/);
  assert.match(actions, /resolveOperationalPaymentState/);
});

test('5. refunded/cancelled bloqueiam operação', () => {
  const refunded = resolveOperationalPaymentState({
    paymentStatus: 'refunded',
    paymentMethod: 'pix',
    priceOrigin: 'catalog',
    ticketStatus: 'active',
  });
  assert.equal(refunded.kind, 'refunded');
  assert.equal(refunded.operational, false);

  const cancelled = resolveOperationalPaymentState({
    paymentStatus: 'paid',
    paymentMethod: null,
    priceOrigin: 'legacy_unknown',
    ticketStatus: 'cancelled',
  });
  assert.equal(cancelled.kind, 'cancelled');
  assert.equal(cancelled.operational, false);
  assert.match(migration, /Ingresso cancelado\. Check-in bloqueado/);
});

test('6. legacy_unknown amount 0 nao vira preco real', () => {
  assert.equal(formatImportedHistoricalAmount(0, 'legacy_unknown'), 'Não informado');
  assert.doesNotMatch(migration, /final_amount\s*=\s*[1-9]/);
  assert.match(migration, /coalesce\(p\.amount, 0\) = 0/);
});

test('7. legacy method NULL nao inventa PIX/cartao', () => {
  const state = resolveOperationalPaymentState({
    paymentStatus: 'paid',
    paymentMethod: null,
    priceOrigin: 'legacy_unknown',
  });
  assert.equal(state.methodLabel, 'Não informado');
  assert.doesNotMatch(state.methodLabel, /pix|cart[aã]o/i);
  assert.match(migration, /and p\.payment_method is null/);
  assert.doesNotMatch(migration, /payment_method = 'pix'/);
});

test('8. backfill nao chama Asaas e fica no batch oficial', () => {
  const executable = migration.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(executable, /https?:|webhook|payment_gateway_charges/i);
  const backfill = migration.slice(migration.indexOf('with backfill as'));
  assert.doesNotMatch(backfill, /asaas/i);
  assert.match(migration, new RegExp(OFFICIAL_BATCH));
  assert.match(migration, /o\.import_batch_id = 'aee74ffb-1eb3-4742-818f-77b701fd7da0'/);
  assert.match(migration, /p\.gateway_payment_id is null/);
  assert.match(migration, /legacy_historical_payment_settled/);
});

test('9. QR existente nao e reemitido nem cancelado', () => {
  const backfill = migration.slice(migration.indexOf('with backfill as'));
  assert.doesNotMatch(backfill, /update public\.tickets/);
  assert.doesNotMatch(backfill, /insert into public\.tickets/);
  assert.doesNotMatch(backfill, /owner_user_id/);
  assert.doesNotMatch(backfill, /intended_owner/);
  assert.doesNotMatch(backfill, /holder_full_name/);
  assert.doesNotMatch(migration, /insert into public\.tickets/);
});

test('10. RPCs de entrega/check-in usam o gate operacional e undo nao foi removido', () => {
  assert.match(migration, /if not public\.ticket_has_operational_payment\(v_order\.id\)/);
  assert.match(migration, /if not public\.ticket_has_operational_payment\(v_ticket\.order_id\)/);
  assert.match(actions, /undo_ticket_checkin/);
  assert.match(actions, /undo_ticket_full_kit/);
  assert.match(gateway, /pending nao emite ticket/);
  assert.match(gateway, /nenhum ticket deve ser emitido para pagamento pendente/);
});
