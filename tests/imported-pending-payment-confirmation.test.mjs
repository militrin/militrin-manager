import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = await readFile(new URL('../supabase/migrations/20260942000000_confirm_imported_pending_payment_and_reconcile.sql', import.meta.url), 'utf8');
const actions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
const detail = await readFile(new URL('../src/app/cadastros/[id]/page.tsx', import.meta.url), 'utf8');
const confirmation = migration.match(/create or replace function public\.confirm_imported_pending_payment_and_reconcile[\s\S]*?end; \$\$;/)?.[0] ?? '';
const finalizer = migration.match(/create or replace function public\.finalize_imported_ticket_after_issue_resolution[\s\S]*?end; \$\$;/)?.[0] ?? '';

test('pending continua sem emissao ate confirmacao administrativa', () => {
  assert.match(finalizer, /v_payment\.payment_status <> 'paid'[\s\S]*payment_mode_original,'pending'\)='pending'[\s\S]*not p_force_confirm/);
  assert.match(finalizer, /v_finalization:='payment_pending'/);
});

test('confirmacao usa a finalizadora canonica para todos os ingressos', () => {
  assert.match(confirmation, /for v_item in[\s\S]*oi\.item_kind='ticket'/);
  assert.match(confirmation, /finalize_imported_ticket_after_issue_resolution\(v_item\.id,array\['payment_confirmation'\]::text\[\],true\)/);
});

test('produtos do mesmo pedido sao ignorados', () => {
  assert.match(confirmation, /oi\.item_kind='ticket'/);
  assert.doesNotMatch(confirmation, /item_kind\s*(?:<>|!=)\s*'product'/);
});

test('issues bloqueantes impedem confirmar e emitir', () => {
  assert.match(confirmation, /i\.blocks_payment or i\.blocks_ticket_issuance/);
  assert.match(confirmation, /'reason_code','issues_remaining'/);
});

test('reprocessamento e idempotente e pagamento ja pago libera reconciliacao posterior', () => {
  assert.match(finalizer, /v_payment\.payment_status='paid'/);
  assert.match(finalizer, /select id into v_ticket_id from public\.tickets where order_item_id=v_item\.id/);
  assert.match(finalizer, /if v_ticket_id is null then select public\.confirm_order_item_and_issue_ticket/);
});

test('auditoria registra ator, motivo e escopo da confirmacao', () => {
  assert.match(confirmation, /'imported_payment_confirmed'/);
  for (const field of ['actor_user_id', 'reason', 'order_id', 'import_batch_id', 'ticket_items_attempted']) assert.match(confirmation, new RegExp(`'${field}'`));
});

test('cadastro explica payment_pending e oferece CTA protegido', () => {
  assert.match(detail, /Ingresso importado aguardando pagamento/);
  assert.match(detail, /finance\.confirm_payment/);
  assert.match(detail, /ImportedPaymentConfirmation/);
  assert.match(actions, /confirm_imported_pending_payment_and_reconcile/);
  for (const path of ['/cadastros', '/ingressos', '/minha-conta', '/minha-conta/ingressos', '/operacoes']) assert.ok(actions.includes(`revalidatePath("${path}")`));
});
