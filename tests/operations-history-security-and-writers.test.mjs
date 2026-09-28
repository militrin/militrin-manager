import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { FINANCIAL_AUDIT_ACTIONS, HISTORY_AUDIT_ACTIONS } from '../src/lib/operations/history/constants.ts';

const migrationUrl = new URL('../supabase/migrations/20261114000000_operations_history_indexes_and_canonical_kit.sql', import.meta.url);
const queryUrl = new URL('../src/lib/operations/history/query.ts', import.meta.url);
const actionsUrl = new URL('../src/app/operacoes/relatorio/actions.ts', import.meta.url);
const clientUrl = new URL('../src/app/operacoes/relatorio/operations-history-client.tsx', import.meta.url);
const pageUrl = new URL('../src/app/operacoes/relatorio/page.tsx', import.meta.url);
const urlUrl = new URL('../src/lib/operations/history/url.ts', import.meta.url);
const layoutUrl = new URL('../src/app/operacoes/relatorio/layout.tsx', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

test('writers novos gravam kit_delivered e kit_delivery_undone sem apagar logs por item', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const deliver = extractFunction(sql, 'deliver_ticket_full_kit');
  const undo = extractFunction(sql, 'undo_ticket_full_kit');
  assert.match(deliver, /perform public\.deliver_ticket_kit_item/);
  assert.match(deliver, /'kit_delivered'/);
  assert.match(deliver, /if v_delivered > 0 then/);
  assert.match(deliver, /'operation', 'full_kit_delivery'/);
  assert.doesNotMatch(deliver, /delete from public\.audit_logs/);
  assert.match(undo, /perform public\.undo_ticket_kit_item/);
  assert.match(undo, /'kit_delivery_undone'/);
  assert.match(undo, /'operation', 'full_kit_undo'/);
  assert.doesNotMatch(undo, /delete from public\.audit_logs/);
});

test('migration cria índices event_id + created_at e event_id + action + created_at, sem backfill', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /create index if not exists idx_audit_logs_event_created_at_desc/);
  assert.match(sql, /on public\.audit_logs \(event_id, created_at desc\)/);
  assert.match(sql, /create index if not exists idx_audit_logs_event_action_created_at_desc/);
  assert.match(sql, /on public\.audit_logs \(event_id, action, created_at desc\)/);
  assert.match(sql, /create index if not exists idx_ticket_holder_history_event_created_at_desc/);
  assert.doesNotMatch(sql, /update public\.audit_logs/);
  assert.doesNotMatch(sql, /insert into public\.audit_logs\s+select /i);
});

test('leitura do histórico exige operations.view_report no servidor e usa service role só em audit_logs', async () => {
  const [query, actions, layout] = await Promise.all([
    readFile(queryUrl, 'utf8'),
    readFile(actionsUrl, 'utf8'),
    readFile(layoutUrl, 'utf8'),
  ]);
  assert.match(query, /assertPermission\("operations.view_report"\)/);
  assert.match(query, /createServiceRoleSupabaseClient\(\)/);
  assert.match(query, /\.from\("audit_logs"\)/);
  assert.match(actions, /queryOperationsHistory/);
  assert.match(layout, /requirePermission\("operations.view_report"\)/);
  const serviceRoleIndex = query.indexOf('createServiceRoleSupabaseClient()');
  const holderIndex = query.indexOf('.from("ticket_holder_history")');
  assert.ok(serviceRoleIndex > -1 && holderIndex > serviceRoleIndex);
});

test('allowlist operacional não inclui financeiro e a query não seleciona valores de pagamento', async () => {
  const query = await readFile(queryUrl, 'utf8');
  for (const action of FINANCIAL_AUDIT_ACTIONS) {
    assert.equal(HISTORY_AUDIT_ACTIONS.includes(action), false, action);
    assert.doesNotMatch(query, new RegExp(`['"]${action}['"]`));
  }
  assert.doesNotMatch(query, /payment_amount|net_amount|asaas|pix_qr|service_role_key/i);
  assert.doesNotMatch(query, /\.from\("payments"\)/);
  assert.doesNotMatch(query, /\.from\("financial_/);
});

test('o client da Central não recebe service role nem calcula cards só com a página de 50', async () => {
  const [client, page, query, url] = await Promise.all([
    readFile(clientUrl, 'utf8'),
    readFile(pageUrl, 'utf8'),
    readFile(queryUrl, 'utf8'),
    readFile(urlUrl, 'utf8'),
  ]);
  assert.doesNotMatch(client, /createServiceRoleSupabaseClient|SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(page, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(client, /document.visibilityState/);
  assert.match(client, /30_000/);
  assert.match(query, /countOperationCards\(filtered\)/);
  assert.match(query, /paginateByCursor\(filtered/);
  assert.match(page, /parseHistorySearchParams/);
  assert.match(url, /: "today"/);
  assert.match(page, /Acompanhe as operações realizadas no evento/);
  assert.doesNotMatch(page, /ReportsExplorer/);
  assert.match(client, /Filtros •/);
  assert.match(client, /mobileSheet/);
  assert.doesNotMatch(client, /Operador:/);
});
