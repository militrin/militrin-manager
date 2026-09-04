import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  chipStatusForOwnedTicketPayment,
  normalizeOwnedTicketPaymentChipStatus,
} from '../src/lib/account/ticket-payment-operational-status.ts';

const migration = await readFile(
  new URL('../supabase/migrations/20260950000000_ticket_owner_payment_operational_status.sql', import.meta.url),
  'utf8',
);
const ingressosPage = await readFile(
  new URL('../src/app/minha-conta/ingressos/page.tsx', import.meta.url),
  'utf8',
);
const chips = await readFile(
  new URL('../src/components/militrin/status-chips.ts', import.meta.url),
  'utf8',
);

const helper = await readFile(
  new URL('../src/lib/account/ticket-payment-operational-status.ts', import.meta.url),
  'utf8',
);

test('Minha Conta nao le payments direto nem mascara falha como pendente', () => {
  assert.match(ingressosPage, /loadOwnedTicketsPaymentOperationalStatus/);
  assert.match(ingressosPage, /chipStatusForOwnedTicketPayment/);
  assert.match(helper, /get_my_tickets_payment_operational_status/);
  assert.doesNotMatch(ingressosPage, /\.from\(['"]payments['"]\)/);
  assert.doesNotMatch(ingressosPage, /payment\?\.payment_status \?\? 'pending'/);
  assert.doesNotMatch(helper, /\?\? 'pending'/);
});

test('migration 50 reusa a RPC do Gate #1 e nao abre RLS de payments', () => {
  assert.match(migration, /create or replace function public\.get_ticket_payment_operational_status\(p_ticket_id uuid\)/);
  assert.match(migration, /v_ticket\.owner_user_id is distinct from v_actor/);
  assert.match(migration, /create or replace function public\.get_my_tickets_payment_operational_status\(\)/);
  assert.match(migration, /where t\.owner_user_id = v_actor/);
  assert.doesNotMatch(migration, /create policy/i);
  assert.doesNotMatch(migration, /on public\.payments/i);
  assert.match(
    migration,
    /revoke all on function public\.get_my_tickets_payment_operational_status\(\)\s+from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(migration, /pix_code|gateway_payment_id|final_amount/);
});

test('chip confirma paid/confirmed e nao trata leitura falha como pendente', () => {
  assert.match(chips, /normalized === 'confirmed' \|\| normalized === 'paid'/);
  assert.match(chips, /label: 'Pagamento confirmado'/);
  assert.match(chips, /normalized === 'pending' \|\| normalized === 'processing' \|\| normalized === 'reserved'/);
  assert.match(chips, /label: 'Pagamento pendente'/);
  assert.match(chips, /normalized === 'unavailable' \|\| normalized === 'unknown'/);
  assert.match(chips, /label: 'Pagamento indisponível'/);
  assert.match(chips, /tone: 'neutral'/);
});

test('Maria owner de 3 tickets paid/confirmed: holder nao muda o chip', () => {
  const load = {
    byTicketId: new Map([
      ['ticket-joao', 'paid'],
      ['ticket-maria', 'paid'],
      ['ticket-pedro', 'paid'],
    ]),
    error: null,
  };
  for (const ticketId of ['ticket-joao', 'ticket-maria', 'ticket-pedro']) {
    assert.equal(
      normalizeOwnedTicketPaymentChipStatus(chipStatusForOwnedTicketPayment(ticketId, load)),
      'confirmed',
    );
  }
  assert.match(chips, /label: 'Pagamento confirmado'/);
});

test('helper nunca promove ausencia de leitura a pending', () => {
  assert.equal(
    chipStatusForOwnedTicketPayment('t1', { byTicketId: new Map(), error: { message: 'falha' } }),
    'unavailable',
  );
  assert.equal(
    chipStatusForOwnedTicketPayment('t1', { byTicketId: new Map(), error: null }),
    'unavailable',
  );
  assert.equal(
    chipStatusForOwnedTicketPayment('t1', { byTicketId: new Map([['t1', 'paid']]), error: null }),
    'paid',
  );
  assert.equal(
    chipStatusForOwnedTicketPayment('t1', { byTicketId: new Map([['t1', 'pending']]), error: null }),
    'pending',
  );
  assert.equal(normalizeOwnedTicketPaymentChipStatus('paid'), 'confirmed');
  assert.equal(normalizeOwnedTicketPaymentChipStatus('pending'), 'pending');
  assert.equal(normalizeOwnedTicketPaymentChipStatus('unavailable'), 'unavailable');
});
