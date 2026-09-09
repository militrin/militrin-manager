import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [
  migration,
  provider,
  webhook,
  orderPage,
  financePage,
  dashboard,
  modal,
  paymentPage,
  actions,
  statusMap,
] = await Promise.all([
  read('supabase/migrations/20261008000000_administrative_asaas_refund.sql'),
  read('src/lib/payments/asaas-provider.ts'),
  read('src/app/api/webhooks/asaas/route.ts'),
  read('src/app/inscricoes/pedido/[orderId]/page.tsx'),
  read('src/app/financeiro/page.tsx'),
  read('src/lib/dashboard/admin-dashboard-data.ts'),
  read('src/app/financeiro/pagamento/admin-refund-modal.tsx'),
  read('src/app/financeiro/pagamento/[paymentId]/page.tsx'),
  read('src/app/financeiro/pagamento/actions.ts'),
  read('src/lib/payments/asaas-status-map.ts'),
]);

test('migration: refund_status, historico, auth finance.refund, tickets so com checkbox', () => {
  assert.match(migration, /payment_refund_attempts/);
  assert.match(migration, /refund_status/);
  assert.match(migration, /ux_payment_refund_attempts_open/);
  assert.match(migration, /finance\.refund/);
  assert.match(migration, /begin_admin_payment_refund/);
  assert.match(migration, /finalize_payment_refund_side_effects/);
  assert.match(migration, /apply_refund_linked_entitlement_cancellations/);
  assert.match(migration, /PAYMENT_REFUNDED/);
  assert.match(migration, /PAYMENT_REFUND_FAILED/);
  assert.match(migration, /Pagamento estornado/);
  assert.match(migration, /Falha ao estornar pagamento/);
  assert.match(migration, /on conflict \(organization_id, type, entity_id\) do nothing/);
  assert.match(migration, /cancellation_replacement_required = false/);
  assert.match(migration, /v_skip_reason := 'used'/);
  assert.match(migration, /v_skip_reason := 'kit_delivered'/);
  assert.match(migration, /refunded_amount, remaining_amount/);
  assert.doesNotMatch(migration, /delete from public\.tickets/);
  assert.match(migration, /if coalesce\(v_remaining_paid, 0\) = 0 then/);
});

test('estorno de payment nao cancela ingresso no _apply_terminal', () => {
  const refundBranch = migration.split("if p_target_status = 'refunded' then")[1].split('else')[0];
  assert.doesNotMatch(refundBranch, /update public\.tickets set status = 'cancelled'/);
  assert.doesNotMatch(refundBranch, /release_store_item_reservation/);
});

test('client Asaas reutilizado: refund full omite value, timeout e already refunded', () => {
  assert.match(provider, /async refundPayment/);
  assert.match(provider, /Full refund: omit `value`/);
  const refundFn = provider.slice(provider.indexOf('async refundPayment'));
  assert.doesNotMatch(refundFn, /value: input\.amount/);
  assert.match(provider, /GatewayTimeoutError/);
  assert.match(provider, /isAsaasAlreadyRefundedError/);
  assert.match(provider, /ASAAS_REFUND_TIMEOUT_MS/);
});

test('webhook continua aplicando event type e nao chama Asaas do browser', () => {
  assert.match(webhook, /p_event_type: event.eventType/);
  assert.match(webhook, /apply_gateway_payment_status/);
  assert.doesNotMatch(webhook, /refundPayment/);
  assert.match(actions, /assertPermission\("finance.refund"\)/);
  assert.doesNotMatch(modal, /fetch\(['"]https:\/\/api/);
});

test('pontos de entrada descobriveis: pedido, financeiro e dashboard', () => {
  assert.match(orderPage, /ESTORNAR PAGAMENTO/);
  assert.match(orderPage, /\/financeiro\/pagamento\//);
  assert.match(financePage, /Estornar pagamento/);
  assert.match(financePage, /\/financeiro\/pagamento\/\$\{row.id\}/);
  assert.match(dashboard, /\/financeiro\/pagamento\/\$\{payment.id\}/);
  assert.match(paymentPage, /ESTORNAR PAGAMENTO/);
  assert.match(modal, /Cancelar ingressos ativos vinculados/);
  assert.match(modal, /Digite exatamente/);
  assert.match(modal, /ADMIN_REFUND_REASON_LABELS/);
  assert.doesNotMatch(modal, /partial refund|estorno parcial/i);
  assert.match(statusMap, /PAYMENT_PARTIALLY_REFUNDED/);
});
