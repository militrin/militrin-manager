import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [
  migration,
  environmentMigration,
  actions,
  dashboard,
  painel,
  details,
  permissions,
  finance,
  webhookMap,
] = await Promise.all([
  read('supabase/migrations/20261006000000_resolve_shirt_variant_on_issue.sql'),
  read('supabase/migrations/20261007000000_gateway_environment_and_refund_event.sql'),
  read('src/app/importacoes/actions.ts'),
  read('src/lib/dashboard/admin-dashboard-data.ts'),
  read('src/app/painel/page.tsx'),
  read('src/app/painel/detalhes/page.tsx'),
  read('src/lib/dashboard/dashboard-permissions.ts'),
  read('src/app/financeiro/page.tsx'),
  read('src/lib/payments/asaas-status-map.ts'),
]);

test('camada compartilhada resolve Tipo+Tamanho na materializacao e no attach do ticket', () => {
  assert.match(migration, /create or replace function public\.materialize_order_item_kit_reservations/);
  assert.match(migration, /create or replace function public\.attach_order_item_kit_items_to_new_ticket/);
  assert.match(migration, /lower\(trim\(v\.name\)\)=lower\(trim\(new\.shirt_type\)\)/);
  assert.match(migration, /upper\(trim\(v\.value\)\)=upper\(trim\(new\.shirt_size\)\)/);
  assert.match(migration, /if v_variant_count<>1 then v_variant_id:=null/);
  assert.match(migration, /perform public\.account_ticket_shirt_demand\(v_link\)/);
  assert.doesNotMatch(migration, /perform public\.ensure_ticket_kit_items/);
});

test('importador usa a mesma resolucao e nao escolhe 0 ou >1 silenciosamente', () => {
  assert.match(actions, /resolveShirtVariant\(eventRules\.shirtVariants/);
  assert.match(actions, /shirtVariantReviewIssue/);
});

test('dashboard receita confirmada usa a formula canonica e tem drill-down', () => {
  assert.match(dashboard, /shouldIncludeInConfirmedRevenue/);
  assert.match(dashboard, /confirmedRevenueAmount/);
  assert.match(dashboard, /shouldIncludeInRefundedRevenue/);
  assert.match(dashboard, /refundedRevenueAmount/);
  assert.match(dashboard, /revenue_refunded/);
  assert.match(dashboard, /gatewayEnvironmentLabel/);
  assert.match(painel, /Ver composição/);
  assert.match(details, /revenue_refunded/);
  assert.match(details, /Soma das linhas = card/);
  assert.match(permissions, /revenue_refunded: 'finance'/);
  assert.match(finance, /gatewayEnvironmentLabel/);
  assert.match(finance, /SANDBOX/);
});

test('webhook de refund usa o tipo do evento e e idempotente por unique', () => {
  assert.match(webhookMap, /PAYMENT_PARTIALLY_REFUNDED/);
  assert.match(webhookMap, /mapAsaasWebhookToInternalStatus/);
  assert.match(environmentMigration, /PAYMENT_PARTIALLY_REFUNDED/);
  assert.match(environmentMigration, /gateway_environment/);
  assert.match(environmentMigration, /asaas-conta-live-01/);
});

test('shirt_coherence distingue resolvivel automaticamente de revisao', () => {
  assert.match(dashboard, /shirt_auto_resolvable/);
  assert.match(dashboard, /Origem tem \$\{shirtType\} \$\{shirtSize\}/);
  assert.match(details, /Combinação inequívoca é resolvível automaticamente/);
});
