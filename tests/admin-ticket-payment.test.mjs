import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  adminTicketPaymentStatusForList,
  classifyAdminTicketPayment,
  isActivePaidAdminTicket,
  isLegacyImportedOrder,
  matchesAdminTicketPaymentFilter,
} from '../src/lib/admin/admin-ticket-payment.ts';

const BATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const migration54 = await readFile(new URL('../supabase/migrations/20260954000000_imported_ticket_payment_filter.sql', import.meta.url), 'utf8');
const helper = await readFile(new URL('../src/lib/admin/admin-ticket-payment.ts', import.meta.url), 'utf8');
const migration53 = await readFile(new URL('../supabase/migrations/20260953000000_list_admin_tickets.sql', import.meta.url), 'utf8');

const nativePaid = {
  buyerType: 'account',
  importBatchId: null,
  ticketStatus: 'active',
  orderStatus: 'confirmed',
  paymentStatus: 'paid',
  situacao: 'ativos',
};
const nativePending = {
  buyerType: 'account',
  importBatchId: null,
  ticketStatus: 'active',
  orderStatus: 'pending',
  paymentStatus: 'pending',
  situacao: 'ativos',
};
const legacyNoPayment = {
  buyerType: 'imported_holder',
  importBatchId: BATCH,
  ticketStatus: 'active',
  orderStatus: 'confirmed',
  paymentStatus: null,
  situacao: 'ativos',
};
const legacyCancelled = {
  buyerType: 'imported_holder',
  importBatchId: BATCH,
  ticketStatus: 'cancelled',
  orderStatus: 'cancelled',
  paymentStatus: null,
  situacao: 'cancelados',
};

test('ticket nativo paid => Pago', () => {
  assert.equal(classifyAdminTicketPayment(nativePaid), 'pago');
  assert.equal(adminTicketPaymentStatusForList(nativePaid), 'paid');
});

test('ticket nativo pending => Pendente', () => {
  assert.equal(classifyAdminTicketPayment(nativePending), 'pendente');
  assert.equal(matchesAdminTicketPaymentFilter(nativePending, 'pendente'), true);
  assert.equal(matchesAdminTicketPaymentFilter(nativePending, 'pago'), false);
});

test('ticket legado sem payment moderno => Pago', () => {
  assert.equal(isLegacyImportedOrder(legacyNoPayment), true);
  assert.equal(classifyAdminTicketPayment(legacyNoPayment), 'pago');
  assert.equal(adminTicketPaymentStatusForList(legacyNoPayment), 'paid');
});

test('ticket legado cancelado sem estorno continua Pago financeiramente', () => {
  assert.equal(classifyAdminTicketPayment(legacyCancelled), 'pago');
  assert.equal(matchesAdminTicketPaymentFilter(legacyCancelled, 'pago'), true);
  assert.equal(isActivePaidAdminTicket(legacyCancelled), false);
  assert.equal(classifyAdminTicketPayment({ ...legacyCancelled, paymentStatus: 'paid' }), 'pago');
});

test('legado so vira Cancelado financeiro com estorno/reembolso real', () => {
  assert.equal(classifyAdminTicketPayment({ ...legacyCancelled, paymentStatus: 'refunded' }), 'cancelado');
  assert.equal(classifyAdminTicketPayment({ ...legacyCancelled, paymentStatus: 'cancelled' }), 'cancelado');
  assert.equal(matchesAdminTicketPaymentFilter({ ...legacyCancelled, paymentStatus: 'refunded' }, 'pago'), false);
});

test('legado com payment pending placeholder continua Pago, nao Pendente', () => {
  const legacyPending = { ...legacyNoPayment, paymentStatus: 'pending' };
  assert.equal(classifyAdminTicketPayment(legacyPending), 'pago');
  assert.equal(matchesAdminTicketPaymentFilter(legacyPending, 'pendente'), false);
  assert.equal(matchesAdminTicketPaymentFilter(legacyPending, 'pago'), true);
});

test('filtro Pago inclui legado ativo e legado cancelado sem estorno', () => {
  const rows = [nativePaid, nativePending, legacyNoPayment, legacyCancelled];
  const paid = rows.filter((row) => matchesAdminTicketPaymentFilter(row, 'pago')).map((row) => `${row.buyerType}:${row.ticketStatus}:${String(row.paymentStatus)}`);
  assert.deepEqual(paid, ['account:active:paid', 'imported_holder:active:null', 'imported_holder:cancelled:null']);
});

test('filtro Pendente nao inclui legado', () => {
  const rows = [nativePaid, nativePending, legacyNoPayment, legacyCancelled];
  const pending = rows.filter((row) => matchesAdminTicketPaymentFilter(row, 'pendente'));
  assert.equal(pending.length, 1);
  assert.equal(pending[0], nativePending);
  assert.equal(matchesAdminTicketPaymentFilter(legacyNoPayment, 'pendente'), false);
});

test('nativo sem payment nao vira pendente inventado', () => {
  const nativeNone = {
    buyerType: 'account',
    importBatchId: null,
    ticketStatus: 'active',
    orderStatus: 'confirmed',
    paymentStatus: null,
  };
  assert.equal(classifyAdminTicketPayment(nativeNone), null);
  assert.equal(matchesAdminTicketPaymentFilter(nativeNone, 'pendente'), false);
  assert.equal(matchesAdminTicketPaymentFilter(nativeNone, 'pago'), false);
});

test('legado e identificado por buyer_type+import_batch_id, nao por nome', () => {
  assert.equal(isLegacyImportedOrder({ buyerType: 'account', importBatchId: BATCH }), false);
  assert.equal(isLegacyImportedOrder({ buyerType: 'imported_holder', importBatchId: null }), false);
  assert.equal(isLegacyImportedOrder({ buyerType: 'administrative', importBatchId: null }), false);
  assert.doesNotMatch(helper, /full_name|email|holder_name/);
  assert.match(helper, /buyer_type = 'imported_holder'/);
  assert.match(helper, /import_batch_id IS NOT NULL/);
});

test('migration 54 altera so a classificacao de listagem e nao a 53 aplicada', () => {
  assert.match(migration54, /ticket_admin_payment_class/);
  assert.match(migration54, /buyer_type/);
  assert.match(migration54, /imported_holder/);
  assert.match(migration54, /p_import_batch_id/);
  assert.match(migration54, /list_admin_tickets/);
  assert.match(migration54, /Nao grava payment/);
  assert.doesNotMatch(migration54, /insert into public\.payments/i);
  assert.doesNotMatch(migration54, /update public\.payments/i);
  assert.doesNotMatch(migration54, /delete from public\.(tickets|orders|payments)/i);
  assert.match(migration53, /v_pagamento = 'pago' and pay\.payment_status = 'paid'/);
  assert.match(migration54, /f\.payment_class = v_pagamento/);
  const paymentFn = migration54.match(/create or replace function public\.ticket_admin_payment_class[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.match(paymentFn, /p_payment_status/);
  assert.doesNotMatch(paymentFn, /p_ticket_status|p_order_status/);
});
