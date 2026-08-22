import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';
import {
  calculateAgeAtDate,
  hasTicketBlockingIssues,
  isValidCpf,
  matchCurrentImportIdentity,
  resolveImportOption,
  resolveImportOptionWithDefault,
} from '../src/lib/imports/import-row-validation.ts';
import { CANONICAL_FIELD_LABELS, inferColumnMapping } from '../src/lib/imports/columns.ts';
import { deduplicateTicketTimelineEvents, loadOptionalTimelineSource } from '../src/lib/admin/ticket-timeline-query.ts';
import { getTimelineStateLabel, TIMELINE_STATE_LABELS } from '../src/lib/status-labels.ts';
import { timelineTypeOptions } from '../src/lib/admin/ticket-event-taxonomy.ts';
import { parseSpreadsheetMatrix } from '../src/lib/imports/parse-file.ts';
import { evaluateParticipantInviteAccess } from '../src/lib/account/participant-invite-policy.ts';
import { getParticipantOperationBlocks, isAdministrativeIssue, isRequiredUserResolvableIssue } from '../src/lib/account/participant-issue-policy.ts';
import { formatReportDateTime, REPORT_THEME, reportIsoDateTime, splitTechnicalIdentifier } from '../src/lib/reports/report-theme.ts';
import { ticketTimelineToXlsx } from '../src/lib/reports/ticket-timeline-xlsx.ts';
import ExcelJS from 'exceljs';
import XLSX from 'xlsx';

test('diagnostico da politica de eventos e somente leitura e comprova os bloqueadores legados', async () => {
  const diagnostic = await readFile(new URL('../supabase/plans/109_event_policy_diagnostic.sql', import.meta.url), 'utf8');
  const preflight = await readFile(new URL('../supabase/plans/109_multi_active_event_policy_preflight.sql', import.meta.url), 'utf8');
  const report = await readFile(new URL('../docs/event-policy-diagnostic.md', import.meta.url), 'utf8');
  for (const sql of [diagnostic, preflight]) {
    assert.doesNotMatch(sql, /^\s*(insert|update|delete|alter|create|drop|truncate)\b/im);
    assert.match(sql, /safe_to_apply|multiple_active_policy_is_safe/);
  }
  assert.match(diagnostic, /ux_events_single_active/);
  assert.match(diagnostic, /create_event_globally_deactivates_others/);
  assert.match(preflight, /active_event_limit_one_function_count/);
  assert.match(preflight, /explicit_archive_state_exists/);
  assert.match(report, /create_event.*sem filtro de organiza/is);
  assert.match(report, /getActiveEventId\(\).*maybeSingle/s);
});

test('migration 109 permite multiplos ativos com arquivamento, RBAC, isolamento e auditoria', async () => {
  const migration = await readFile(new URL('../supabase/migrations/109_multi_active_event_policy.sql', import.meta.url), 'utf8');
  for (const expected of ['drop index if exists public.ux_events_single_active', 'archived_at timestamptz', 'archived_by uuid',
    "current_user_has_permission('events.edit')", "current_user_has_permission('events.publish')", "current_user_has_permission('events.archive')",
    'user_can_access_organization', 'set_event_inactive', 'restore_event', 'event_activated', 'event_deactivated',
    'event_sales_opened', 'event_sales_closed', 'event_archived', 'event_restored']) assert.match(migration, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  assert.doesNotMatch(migration, /where\s+is_active\s*=\s*true\s+and\s+id\s*<>/i);
  assert.doesNotMatch(migration, /update\s+public\.events[\s\S]{0,160}where\s+is_active\s*=\s*true/i);
  assert.match(migration, /revoke all on function public\.set_event_active\(uuid\) from public,anon,authenticated/i);
  assert.match(migration, /update public\.events set is_active=false,registration_enabled=false,archived_at=null,archived_by=null/);
});

test('preflight 109 aceita legado e estado idempotente sem escrever dados', async () => {
  const preflight = await readFile(new URL('../supabase/plans/109_multi_active_event_policy_preflight.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(preflight, /^\s*(insert|update|delete|alter|create|drop|truncate)\b/im);
  for (const field of ['functions_that_deactivate_other_events', 'database_implicit_event_selector_count',
    'inactive_events_with_open_sales_count', 'events_without_organization_count', 'invalid_archived_state_count',
    'anonymous_admin_event_rpc_grant_count', 'legacy_state_supported', 'migration_109_idempotent_state', 'safe_to_apply']) assert.match(preflight, new RegExp(field));
});

test('fluxos administrativos centrais exigem evento explicito e importacao bloqueia ausencia', async () => {
  const files = await Promise.all([
    '../src/app/painel/page.tsx', '../src/app/inscricoes/page.tsx', '../src/app/pedidos/actions.ts',
    '../src/app/relatorios/actions.ts', '../src/app/camisetas/page.tsx', '../src/app/operacoes/page.tsx',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  for (const source of files) {
    assert.doesNotMatch(source, /find\([^\n]*is_active[^\n]*\)\s*\?\?/);
    assert.doesNotMatch(source, /events\[0\]\s*\?\?/);
  }
  const imports = await readFile(new URL('../src/app/importacoes/actions.ts', import.meta.url), 'utf8');
  assert.match(imports, /current_event_registrations' && !eventId/);
  assert.match(imports, /Selecione explicitamente o evento/);
  assert.match(imports, /event_id: eventId/);
  const rpc = await readFile(new URL('../src/lib/supabase/rpc.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(rpc, /getActiveEventId/);
  assert.match(rpc, /event_id: string/);
});

test('dashboard de capacidades agrega eventos e portal lista catalogo plural', async () => {
  const capabilities = await readFile(new URL('../src/lib/admin/event-capabilities.ts', import.meta.url), 'utf8');
  const portal = await readFile(new URL('../src/app/eventos/page.tsx', import.meta.url), 'utf8');
  assert.match(capabilities, /getOrganizationEventCapabilities/);
  assert.match(capabilities, /const eventIds = events\.map/);
  assert.doesNotMatch(capabilities, /\.from\('events'\)[\s\S]{0,220}\.limit\(1\)/);
  assert.match(portal, /events\.map/);
});

test('menu preserva contexto explícito e não oculta Financeiro ou Cupons por vendas fechadas', async () => {
  const sidebar = await readFile(new URL('../src/components/dashboard/Sidebar.tsx', import.meta.url), 'utf8');
  const capabilities = await readFile(new URL('../src/lib/admin/event-capabilities.ts', import.meta.url), 'utf8');
  assert.match(sidebar, /useSearchParams/);
  assert.match(sidebar, /searchParams\.get\("eventId"\)/);
  assert.doesNotMatch(sidebar, /window\.location/);
  assert.match(sidebar, /eventScopedHref/);
  assert.match(sidebar, /eventId=\$\{encodeURIComponent\(selectedEventId\)\}/);
  assert.doesNotMatch(sidebar, /label: "Financeiro"[\s\S]{0,180}requireCapability/);
  assert.doesNotMatch(sidebar, /label: "Cupons"[\s\S]{0,180}requireCapability/);
  assert.match(capabilities, /hasEvents: true/);
});

test('menu remove listagem legada de inscrições e preserva redirecionamento para Cadastros', async () => {
  const sidebar = await readFile(new URL('../src/components/dashboard/Sidebar.tsx', import.meta.url), 'utf8');
  const registrations = await readFile(new URL('../src/app/inscricoes/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(sidebar, /label: "Inscrições"/);
  assert.match(registrations, /redirect\(`\/cadastros/);
  assert.match(registrations, /destination\.set\("eventId", params\.eventId\)/);
  assert.doesNotMatch(registrations, /releaseExpiredReservationsAction/);
  assert.doesNotMatch(registrations, /\.from\(['"]participants['"]\)/);
});

test('Financeiro preserva evento ao filtrar e exibe rótulos em português', async () => {
  const finance = await readFile(new URL('../src/app/financeiro/page.tsx', import.meta.url), 'utf8');
  const selector = await readFile(new URL('../src/components/admin/EventContextSelector.tsx', import.meta.url), 'utf8');
  for (const label of ['Pendentes', 'Confirmados', 'Cancelados', 'Expirados', 'Cortesias']) assert.match(finance, new RegExp(label));
  assert.match(finance, /selectedEventId.*eventId=/s);
  assert.match(selector, /new URLSearchParams\(searchParams\.toString\(\)\)/);
  assert.match(selector, /params\.set\("eventId", eventId\)/);
});

test('Visão geral financeira consolida período e compara eventos sem escolher um implicitamente', async () => {
  const page = await readFile(new URL('../src/app/financeiro/page.tsx', import.meta.url), 'utf8');
  const controls = await readFile(new URL('../src/app/financeiro/overview-controls.tsx', import.meta.url), 'utf8');
  assert.match(page, /Total geral de todos os eventos/);
  assert.match(page, /Comparativo entre eventos/);
  for (const heading of ['Evento','Receita','Estornos','Despesas pagas','A pagar','Resultado']) assert.match(page, new RegExp(heading));
  assert.match(page, /dateFrom/);
  assert.match(page, /dateTo/);
  assert.match(page, /financial_event_allocations/);
  assert.match(page, /FinancialOverviewControls/);
  assert.match(controls, /Todos os eventos/);
  assert.match(controls, /name:\"dateFrom\"\|\"dateTo\"/);
  assert.match(controls, /router\.replace\([^\n]+scroll:false/);
  assert.doesNotMatch(controls, /Aplicar período/);
});

test('comparativo financeiro fixa vários eventos e conta ingressos vendidos e cortesias pela cadeia canônica', async () => {
  const page = await readFile(new URL('../src/app/financeiro/page.tsx', import.meta.url), 'utf8');
  const controls = await readFile(new URL('../src/app/financeiro/overview-controls.tsx', import.meta.url), 'utf8');
  const row = await readFile(new URL('../src/app/financeiro/comparison-row-label.tsx', import.meta.url), 'utf8');
  assert.match(page, /compareRow\?: string \| string\[\]/);
  assert.match(page, /ComparisonEventSelector/);
  assert.match(controls, /Guardar no comparativo/);
  assert.match(controls, /ids\.join\(","\)/);
  assert.match(controls, /params\.append\("compareRow",key\)/);
  assert.match(page, /comparisonSpecs\.flatMap\(\(item\)=>item\.eventIds\)/);
  assert.match(page, /eventIds\.includes\(allocation\.event_id\)/);
  assert.match(page, /eventNames\.join\(" \+ "\)/);
  assert.match(row, /Excluir \$\{label\} do comparativo/);
  assert.match(row, />×<\/button>/);
  assert.match(page, /from\("tickets"\).*order_id/);
  assert.match(page, /from\("orders"\).*payment_id/);
  assert.match(page, /from\("payments"\).*payment_method/);
  assert.match(page, /payment_status\)!=="paid"/);
  assert.match(page, /Ingressos vendidos/);
  assert.match(page, /Cortesias/);
  assert.match(page, /<th className="p-3">Vendidos<\/th>/);
});

test('comparativo financeiro guarda linhas por período e exporta PDF CSV e Excel', async () => {
  const page = await readFile(new URL('../src/app/financeiro/page.tsx', import.meta.url), 'utf8');
  const controls = await readFile(new URL('../src/app/financeiro/overview-controls.tsx', import.meta.url), 'utf8');
  const selector = await readFile(new URL('../src/app/financeiro/comparison-event-selector.tsx', import.meta.url), 'utf8');
  const exporter = await readFile(new URL('../src/app/financeiro/comparison-export-buttons.tsx', import.meta.url), 'utf8');
  assert.match(page, /comparisonSpecs\.flatMap/);
  assert.match(page, /inRange\(entry\.occurred_on,comparisonPeriod\.from,comparisonPeriod\.to\)/);
  assert.match(controls, /const period=`\$\{dateFrom\|\|"\*"\}\.\.\$\{dateTo\|\|"\*"\}`/);
  assert.match(selector, /ComparisonExportButtons/);
  assert.match(exporter, /Exportar PDF/);
  assert.match(exporter, /Exportar CSV/);
  assert.match(exporter, /Exportar Excel/);
  assert.match(exporter, /\\uFEFF/);
  assert.match(exporter, /import\("exceljs"\)/);
  assert.match(exporter, /import\("jspdf"\)/);
  assert.match(exporter, /Página \$\{page\} de \$\{pages\}/);
});

test('dashboard de público separa participação confirmada de check-in e filtra recorrência', async () => {
  const page = await readFile(new URL('../src/app/painel/usuarios/page.tsx', import.meta.url), 'utf8');
  // Rota do menu extraida pra src/lib/navigation/admin-menu.ts (compartilhada
  // com a navegacao mobile) -- o label continua existindo, so mudou de arquivo.
  const adminMenu = await readFile(new URL('../src/lib/navigation/admin-menu.ts', import.meta.url), 'utf8');
  assert.match(adminMenu, /Público e recorrência/);
  assert.match(page, /Participation confirmed|Participação confirmada/);
  assert.match(page, /Presença por check-in/);
  assert.match(page, /Últimos 3 anos/);
  assert.match(page, /Mínimo de eventos/);
  assert.match(page, /Máximo de eventos/);
  assert.match(page, /Participou de todos os eventos do período/);
  assert.match(page, /name="requiredEvent"/);
  assert.match(page, /const userId = participant\.user_id/);
  assert.match(page, /const userId = history\.user_id/);
  assert.match(page, /hasPermission\("participants\.view"\)/);
  assert.match(page, /participation_history[\s\S]*\.in\("event_id", eventIds\)/);
});

test('Cupons pertencem a organizacao e as RPCs de mutacao revalidam permissao/organizacao antes de escrever', async () => {
  // Evolucao estrutural: cupom deixou de ser preso a um evento selecionado
  // na tela (EventContextSelector) e passou a pertencer a organizacao, com
  // escopo configuravel (coupon_event_scopes/coupon_ticket_category_scopes/
  // coupon_product_scopes). A checagem de acesso deixou de ser um
  // re-fetch superficial do evento em page.tsx/actions.ts e passou a viver
  // DENTRO das RPCs SECURITY DEFINER (mesma linha de defesa real usada por
  // import_current_event_contact_first) -- corrige tambem a falha de
  // seguranca encontrada na auditoria (create_coupon/update_coupon/
  // toggle_coupon_active antigas nao verificavam nada e estavam liberadas
  // ate para "anon").
  const page = await readFile(new URL('../src/app/cupons/page.tsx', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../src/app/cupons/actions.ts', import.meta.url), 'utf8');
  const rpcs = await readFile(new URL('../supabase/migrations/20260828000000_coupon_admin_rpcs.sql', import.meta.url), 'utf8');

  assert.match(page, /getCurrentOrganizationContext/);
  assert.doesNotMatch(page, /EventContextSelector/);

  assert.match(actions, /create_organization_coupon/);
  assert.match(actions, /update_organization_coupon/);
  assert.match(actions, /set_coupon_active/);

  for (const rpcName of ['create_organization_coupon', 'update_organization_coupon', 'set_coupon_active']) {
    const start = rpcs.indexOf(`function public.${rpcName}(`);
    assert.ok(start >= 0, `RPC ${rpcName} deve existir na migration`);
    const body = rpcs.slice(start, start + 1500);
    assert.match(body, /current_user_has_permission\('coupons\.view'\)/, `${rpcName} deve exigir a permissao coupons.view`);
    assert.match(body, /user_can_access_organization/, `${rpcName} deve validar acesso a organizacao`);
  }

  // As RPCs legadas (event_id-only) ficam explicitamente desativadas, nunca
  // silenciosamente incompatveis com o schema novo.
  assert.match(rpcs, /RPC legada desativada: use create_organization_coupon/);
  assert.match(rpcs, /RPC legada desativada: use update_organization_coupon/);
  assert.match(rpcs, /RPC legada desativada: use set_coupon_active/);
});

test('migration 110 cria livro financeiro separado sem backfill de pagamentos', async () => {
  const sql = await readFile(new URL('../supabase/migrations/110_financial_ledger_foundation.sql', import.meta.url), 'utf8');
  for (const table of ['financial_accounts','financial_categories','financial_suppliers','financial_entries','financial_entry_lines','financial_event_allocations','financial_reconciliations','financial_reversals']) assert.match(sql, new RegExp(`create table if not exists public\\.${table}`));
  assert.match(sql, /begin;[\s\S]*commit;/);
  assert.doesNotMatch(sql, /update\s+public\.payments|delete\s+from\s+public\.payments|insert\s+into\s+public\.payments/i);
  assert.match(sql, /entry_kind in \('revenue','expense','transfer','adjustment','reversal'\)/);
  assert.match(sql, /due_date date/);
  assert.match(sql, /source_payment_id uuid references public\.payments/);
});

test('livro 110 exige partida dobrada e rateio por evento da mesma organizacao', async () => {
  const sql = await readFile(new URL('../supabase/migrations/110_financial_ledger_foundation.sql', import.meta.url), 'utf8');
  assert.match(sql, /line_side in \('debit','credit'\)/);
  assert.match(sql, /v_debits<>p_amount or v_credits<>p_amount/);
  assert.match(sql, /Partida dobrada desequilibrada/);
  assert.match(sql, /events where id=\(v_item->>'event_id'\)::uuid and organization_id=p_organization_id/);
  assert.match(sql, /if v_allocated>p_amount/);
});

test('livro 110 protege mestres, lancamentos e conciliacao por RBAC e organizacao', async () => {
  const sql = await readFile(new URL('../supabase/migrations/110_financial_ledger_foundation.sql', import.meta.url), 'utf8');
  for (const fn of ['upsert_financial_account','upsert_financial_category','upsert_financial_supplier','create_financial_entry','post_financial_entry','reconcile_financial_entry','reverse_financial_entry']) assert.match(sql, new RegExp(`function public\\.${fn}`));
  assert.match(sql, /security definer set search_path to 'public','pg_temp'/);
  for (const permission of ['manage_accounts','manage_categories','manage_suppliers','manage_entries','manage_expenses','manage_income','reconcile','approve_refund']) assert.match(sql, new RegExp(`finance\\.${permission}`));
  assert.doesNotMatch(sql, /current_user_has_permission\('finance\.manage_fees'\)/);
  assert.match(sql, /current_user_has_permission\('finance\.confirm_payment'\)/);
  assert.match(sql, /current_user_has_permission\('finance\.refund'\)/);
  assert.match(sql, /user_can_access_organization/);
  assert.match(sql, /enable row level security/g);
  assert.match(sql, /finance\.view_amounts/);
  assert.doesNotMatch(sql, /grant execute[^;]+to\s+(?:anon|public)\s*;/i);
  assert.match(sql, /grant execute[^;]+to authenticated;/i);
});

test('livro 110 suporta conciliacao e estornos parcial e total idempotentes', async () => {
  const sql = await readFile(new URL('../supabase/migrations/110_financial_ledger_foundation.sql', import.meta.url), 'utf8');
  assert.match(sql, /unique \(organization_id,idempotency_key\)/);
  assert.match(sql, /Conciliação invalida para o estado atual/);
  assert.match(sql, /v_total>v_entry\.amount/);
  assert.match(sql, /'partially_settled'/);
  assert.match(sql, /v_reversed\+p_amount>v_entry\.amount/);
  assert.match(sql, /'partially_reversed'/);
  assert.match(sql, /case v_line\.line_side when 'debit' then 'credit' else 'debit' end/);
  assert.match(sql, /financial_entry_reconciled/);
  assert.match(sql, /financial_entry_reversed/);
});

test('preflight 110 e somente leitura e aceita apenas estado limpo ou instalado coerente', async () => {
  const sql = await readFile(new URL('../supabase/plans/110_financial_ledger_foundation_preflight.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b\s+(?:into|table|function|policy|on|from)/i);
  assert.match(sql, /clean_previous_state/);
  assert.match(sql, /idempotent_installed_state/);
  assert.match(sql, /payments_without_organization_count=0/);
  assert.match(sql, /payment_event_organization_mismatch_count=0/);
  assert.match(sql, /anonymous_ledger_rpc_grant_count=0/);
  assert.match(sql, /conflicting_signature_count=0/);
  assert.match(sql, /planned_permission_count=8/);
  assert.match(sql, /incompatible_planned_permission_count=0/);
  assert.match(sql, /admin_permissions_structure_ok/);
  assert.match(sql, /installed_planned_permission_count=pp\.planned_permission_count/);
  assert.match(sql, /ledger_does_not_reuse_fee_permission/);
  assert.match(sql, /installed_master_read_policy_count=3/);
  assert.match(sql, /installed_amount_read_policy_count=5/);
  assert.match(sql, /safe_to_apply/);
});

test('permissoes 110 aceitam ausencia anterior e bloqueiam definicoes incompatíveis', async () => {
  const migration = await readFile(new URL('../supabase/migrations/110_financial_ledger_foundation.sql', import.meta.url), 'utf8');
  const preflight = await readFile(new URL('../supabase/plans/110_financial_ledger_foundation_preflight.sql', import.meta.url), 'utf8');
  assert.match(migration, /if v_conflicts>0 then raise exception/);
  assert.match(migration, /on conflict\(code\) do nothing/);
  assert.match(preflight, /permission_plan p left join public\.admin_permissions ap using\(code\)/);
  assert.doesNotMatch(preflight, /has_finance_manage/);
  assert.match(preflight, /p\.has_finance_view and p\.has_finance_view_amounts and p\.has_finance_confirm and p\.has_finance_refund/);
});

test('Financeiro simples separa receitas despesas contas a pagar pagas e estornos', async () => {
  const page = await readFile(new URL('../src/app/financeiro/page.tsx', import.meta.url), 'utf8');
  for (const label of ['Visão geral','Receitas','Despesas','Contas a pagar','Contas pagas','Estornos','Configurações']) assert.match(page, new RegExp(label));
  for (const removed of ['Contas a receber','Conciliação','Relatórios']) assert.doesNotMatch(page, new RegExp(`\\["[^"]+", "${removed}"\\]`));
  assert.match(page, /active === "sales"[\s\S]*from\("payments"\)|from\("payments"\)[\s\S]*active === "sales"/);
  assert.match(page, /não cria lançamentos no livro/);
  for (const total of ['Receita bruta','Receita líquida','Despesas pagas','Contas a pagar','Resultado líquido']) assert.match(page, new RegExp(total));
  assert.doesNotMatch(page, /insert\([^)]*(financial_entries|financial_entry_lines)/);
});

test('Server Actions financeiras chamam exclusivamente RPCs protegidas da 110', async () => {
  const actions = await readFile(new URL('../src/app/financeiro/actions.ts', import.meta.url), 'utf8');
  for (const rpc of ['upsert_financial_account','upsert_financial_category','upsert_financial_supplier','create_financial_entry','post_financial_entry','reconcile_financial_entry','reverse_financial_entry']) assert.match(actions, new RegExp(rpc));
  assert.doesNotMatch(actions, /\.from\(|\.insert\(|\.update\(|\.delete\(/);
  assert.match(actions, /p_source_payment_id: null/);
});

test('configuracao financeira simples nao solicita dados bancarios nem expõe chave tecnica', async () => {
  const page = await readFile(new URL('../src/app/financeiro/page.tsx', import.meta.url), 'utf8');
  const form = await readFile(new URL('../src/app/financeiro/financial-action-form.tsx', import.meta.url), 'utf8');
  for (const label of ['Preparação simples','Categorias','Fornecedores','Dados bancários não são necessários','Preparar financeiro']) assert.ok(page.includes(label));
  const settingsPanel = page.slice(page.indexOf('function SettingsPanel'), page.indexOf('export default async function FinanceiroPage'));
  for (const forbidden of ['Agência','Número da conta','Conta bancária / dinheiro disponível']) assert.ok(!settingsPanel.includes(forbidden));
  assert.doesNotMatch(settingsPanel, /placeholder="Referência única"/);
  assert.match(form, /type="hidden" name="idempotencyKey"/);
  assert.match(form, /break-all font-mono text-xs/);
  assert.match(page, /break-all font-mono text-xs/);
});

test('migration 112 cria operacao simples de despesa baixa e contas internas sem banco', async () => {
  const migration = await readFile(new URL('../supabase/migrations/112_simple_financial_operations.sql', import.meta.url), 'utf8');
  const preflight = await readFile(new URL('../supabase/plans/112_simple_financial_operations_preflight.sql', import.meta.url), 'utf8');
  for (const fn of ['ensure_simple_financial_accounts','create_simple_financial_expense','settle_simple_financial_expense']) assert.match(migration, new RegExp(fn));
  for (const code of ['SYS_CAIXA','SYS_RECEITAS','SYS_DESPESAS','SYS_A_PAGAR']) assert.match(migration, new RegExp(code));
  for (const action of ['financial_expense_created','financial_expense_settled']) assert.match(migration, new RegExp(action));
  assert.match(migration, /finance\.manage_expenses/);
  assert.match(migration, /finance\.confirm_payment/);
  assert.match(migration, /Pagamento excede o saldo da despesa/);
  assert.doesNotMatch(migration, /bank_code|agency|account_number|service_role/i);
  assert.doesNotMatch(preflight, /\b(insert|update|delete|alter|create|drop|truncate)\b\s+(?:into|table|from)/i);
  assert.match(preflight, /clean_previous_state/);
  assert.match(preflight, /idempotent_installed_state/);
  assert.match(preflight, /safe_to_apply/);
});

test('Server Actions simples usam somente RPCs protegidas da 112', async () => {
  const actions = await readFile(new URL('../src/app/financeiro/actions.ts', import.meta.url), 'utf8');
  for (const rpc of ['ensure_simple_financial_accounts','create_simple_financial_expense','settle_simple_financial_expense','reverse_financial_entry']) assert.match(actions, new RegExp(rpc));
  assert.doesNotMatch(actions, /\.from\(|\.insert\(|\.update\(|\.delete\(/);
});

test('migration 113 permite editar e remover mestres financeiros com preservacao historica', async () => {
  const migration = await readFile(new URL('../supabase/migrations/113_financial_master_data_lifecycle.sql', import.meta.url), 'utf8');
  const preflight = await readFile(new URL('../supabase/plans/113_financial_master_data_lifecycle_preflight.sql', import.meta.url), 'utf8');
  for (const rpc of ['remove_financial_category','remove_financial_supplier']) assert.match(migration, new RegExp(rpc));
  for (const permission of ['finance.manage_categories','finance.manage_suppliers']) assert.match(migration, new RegExp(permission));
  assert.match(migration, /exists\(select 1 from public\.financial_entries where category_id=p_category_id/);
  assert.match(migration, /exists\(select 1 from public\.financial_entries where supplier_id=p_supplier_id/);
  assert.match(migration, /is_active=false/);
  assert.match(migration, /delete from public\.financial_categories/);
  assert.match(migration, /delete from public\.financial_suppliers/);
  assert.match(migration, /uq_financial_suppliers_org_tax_identifier/);
  assert.doesNotMatch(preflight, /\b(insert|update|delete|alter|create|drop|truncate)\b\s+(?:into|table|from)/i);
  assert.match(preflight, /safe_to_apply/);
});

test('interface permite editar e excluir categorias e fornecedores por Server Actions', async () => {
  const page = await readFile(new URL('../src/app/financeiro/page.tsx', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../src/app/financeiro/actions.ts', import.meta.url), 'utf8');
  for (const label of ['Salvar alterações','Excluir categoria','Excluir fornecedor','Motivo']) assert.match(page, new RegExp(label));
  for (const rpc of ['remove_financial_category','remove_financial_supplier']) assert.match(actions, new RegExp(rpc));
  assert.match(page, /name="categoryId" value=\{category\.id\}/);
  assert.match(page, /name="supplierId" value=\{supplier\.id\}/);
  assert.doesNotMatch(actions, /\.from\(|\.insert\(|\.update\(|\.delete\(/);
});

test('diagnostico 110 de backfill historico e somente leitura e classifica ambiguidades', async () => {
  const sql = await readFile(new URL('../supabase/plans/110_financial_ledger_historical_backfill_diagnostic.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /\b(insert|update|delete|alter|create|drop|truncate)\b\s+(?:into|table|from)/i);
  for (const field of ['confirmed_payment_count','pending_payment_count','expired_payment_count','related_order_count','competency_at','effective_received_at','event_id','organization_id','possible_duplicate_count']) assert.match(sql, new RegExp(field));
  assert.match(sql, /o\.id=pay\.order_id or o\.payment_id=pay\.id/);
  assert.match(sql, /confirmed_candidate/);
  assert.match(sql, /read_only_diagnostic/);
  assert.doesNotMatch(sql, /financial_entries/);
});

test('diagnostico 111 percorre pedido itens ingressos comprador titulares categoria lote gateway e auditoria', async () => {
  const sql = await readFile(new URL('../supabase/plans/111_confirmed_payments_cash_backfill_diagnostic.sql', import.meta.url), 'utf8');
  assert.match(sql, /where pay\.payment_status='paid'/);
  assert.doesNotMatch(sql, /payment_status\s+in\s*\([^)]*pending|payment_status='pending'/i);
  for (const source of ['payment_order_links','order_items','tickets','customer_profiles','ticket_categories','registration_batches','gateway_context','confirmation_audit']) assert.match(sql, new RegExp(source));
  assert.match(sql, /o\.id=pay\.order_id or o\.payment_id=pay\.id/);
  assert.match(sql, /t\.order_id=pol\.order_id/);
  assert.match(sql, /hp\.id=t\.participant_id/);
  assert.match(sql, /effective_received_at/);
  assert.match(sql, /competency_at/);
});

test('diagnostico 111 exclui somente duplicidade comprovada e preserva compras repetidas legítimas', async () => {
  const sql = await readFile(new URL('../supabase/plans/111_confirmed_payments_cash_backfill_diagnostic.sql', import.meta.url), 'utf8');
  for (const classification of ['proven_distinct_sale','confirmed_legacy_revenue_without_order','proven_duplicate','ambiguous_manual_review']) assert.match(sql, new RegExp(classification));
  assert.match(sql, /financial_entry_count>0 or maximum_paid_payments_on_same_order>1 or confirmed_gateway_reference_count>1/);
  assert.match(sql, /final_classification='proven_duplicate' as exclude_from_cash_backfill/);
  assert.doesNotMatch(sql, /equivalent_payment_count|partition by pay\.organization_id,pay\.event_id,pay\.participant_id,pay\.final_amount/);
  assert.match(sql, /query_to_xml/);
  assert.match(sql, /ledger_table_installed/);
  assert.doesNotMatch(sql, /\b(insert|update|delete|alter|create|drop|truncate)\b\s+(?:into|table|from)/i);
});

test('preflight 111 valida UUID de organizacao sem agregacao min inexistente', async () => {
  const sql = await readFile(new URL('../supabase/plans/111_confirmed_payments_cash_backfill_preflight.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /\b(?:min|max)\s*\(\s*(?:\w+\.)?organization_id\s*\)/i);
  assert.match(sql, /count\(distinct organization_id\) from eligible\)=1/i);
  assert.match(sql, /not exists\s*\(\s*select 1\s+from eligible e/i);
  assert.match(sql, /e\.organization_id is distinct from/i);
  assert.match(sql, /a\.id=p\.cash_account_id/i);
  assert.doesNotMatch(sql, /\b(insert|update|delete|alter|create|drop|truncate)\b\s+(?:into|table|from)/i);
});

test('Cadastros concentra finalizacao importada com contexto completo e retorno auditavel', async () => {
  const actions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../supabase/migrations/103_canonical_cadastro_payment_ticket_finalization.sql', import.meta.url), 'utf8');
  assert.match(actions, /finalizeCadastroPaymentAndTicketAction/);
  assert.match(actions, /finalize_cadastro_payment_and_ticket/);
  assert.match(migration, /finalize_imported_participant_after_issue_resolution/);
  for (const predicate of ['participantId', 'paymentId', 'eventId', 'organizationId']) assert.match(actions, new RegExp(predicate));
  for (const output of ['paymentId', 'orderId', 'orderItemId', 'ticketId']) assert.match(actions, new RegExp(output));
  assert.doesNotMatch(actions, /from\("order_items"\)/);
  assert.match(migration, /security definer/);
  assert.doesNotMatch(migration, /limit\s+1/i);
  for (const counter of ['v_payment_count', 'v_order_count', 'v_item_count', 'v_ticket_count']) assert.match(migration, new RegExp(counter));
});

test('retry do F2 usa os mesmos IDs protegidos sem repetir pagamento ou ingresso', async () => {
  const migration = await readFile(new URL('../supabase/migrations/103_canonical_cadastro_payment_ticket_finalization.sql', import.meta.url), 'utf8');
  assert.match(migration, /finalize_imported_participant_after_issue_resolution/);
  assert.match(migration, /v_payment\.payment_status<>'paid'/);
  assert.match(migration, /confirm_order_and_issue_ticket/);
  assert.match(migration, /v_order_count=1 and v_item_count=1 and v_ticket_count=1/);
  assert.match(migration, /return jsonb_build_object\('success',true,'payment_id',p_payment_id,'order_id',v_order_id/);
});

test('item invisivel por RLS e lido somente por funcoes protegidas', async () => {
  const actions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../src/app/cadastros/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(actions, /from\("order_items"\)/);
  assert.match(page, /from\("registration_contacts"\)/);
  assert.match(page, /order_items\(registration_contact_id\)/);
  assert.doesNotMatch(page, /get_cadastro_payment_ticket_context/);
});

test('pagamento confirmado e checkout existente nao criam segundo pedido ou ingresso', async () => {
  const migration = await readFile(new URL('../supabase/migrations/103_canonical_cadastro_payment_ticket_finalization.sql', import.meta.url), 'utf8');
  assert.match(migration, /if v_payment\.payment_status<>'paid' then/);
  assert.match(migration, /finalize_imported_participant_after_issue_resolution/);
  assert.doesNotMatch(migration, /insert into public\.(orders|order_items|tickets)/i);
  assert.match(migration, /payment_id.*order_id.*order_item_id.*ticket_id/s);
});

test('migration 103 rejeita dois pagamentos no contexto', async () => {
  const sql = await readFile(new URL('../supabase/migrations/103_canonical_cadastro_payment_ticket_finalization.sql', import.meta.url), 'utf8');
  assert.match(sql, /v_payment_count<>1/);
  assert.match(sql, /exatamente um pagamento/);
});

test('migration 103 rejeita dois pedidos para participante e pagamento', async () => {
  const sql = await readFile(new URL('../supabase/migrations/103_canonical_cadastro_payment_ticket_finalization.sql', import.meta.url), 'utf8');
  assert.match(sql, /v_order_count>1/);
  assert.match(sql, /mais de um pedido para o mesmo pagamento/);
});

test('migration 103 rejeita dois itens no pedido', async () => {
  const sql = await readFile(new URL('../supabase/migrations/103_canonical_cadastro_payment_ticket_finalization.sql', import.meta.url), 'utf8');
  assert.match(sql, /v_item_count>1/);
  assert.match(sql, /mais de um item/);
});

test('migration 103 rejeita dois ingressos no item', async () => {
  const sql = await readFile(new URL('../supabase/migrations/103_canonical_cadastro_payment_ticket_finalization.sql', import.meta.url), 'utf8');
  assert.match(sql, /v_ticket_count>1/);
  assert.match(sql, /mais de um ingresso/);
});

test('leitor 103 diferencia contexto vazio de checkout unico concluido', async () => {
  const sql = await readFile(new URL('../supabase/migrations/103_canonical_cadastro_payment_ticket_finalization.sql', import.meta.url), 'utf8');
  assert.match(sql, /v_payment_count=0 then return '\{\}'::jsonb/);
  assert.match(sql, /v_order_count=1 and v_item_count=1 and v_ticket_count=1 and v_payment\.payment_status='paid'/);
});

test('preflight 103 e somente leitura, identifica F2 e preserva ambiguidade teste02', async () => {
  const sql = await readFile(new URL('../supabase/plans/103_canonical_cadastro_payment_ticket_finalization_preflight.sql', import.meta.url), 'utf8');
  for (const field of ['has_import_finalizer', 'has_regular_ticket_finalizer', 'has_permission_resolver', 'payments_structure_ok', 'contexts_with_multiple_payments', 'contexts_with_multiple_orders', 'contexts_with_multiple_items', 'contexts_with_multiple_tickets', 'f2_is_complete_unique_checkout', 'teste02_is_ambiguous_unchanged', 'safe_to_apply']) assert.match(sql, new RegExp(field));
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|alter|drop|create)\b/i);
});

test('preflight 104 exige classificacao explicita sem inferir modo pelo estoque', async () => {
  const sql = await readFile(new URL('../supabase/plans/104_event_shirt_supply_mode_preflight.sql', import.meta.url), 'utf8');
  const executableSql = sql.replace(/--.*$/gm, '');
  assert.match(sql, /unclassified_active_shirt_count/);
  assert.match(sql, /planned_classification_count/);
  assert.match(sql, /unclassified_items_covered_by_plan_count/);
  assert.match(sql, /uncovered_unclassified_count/);
  assert.match(sql, /planned_enabled_variant_count/);
  assert.match(sql, /plan_matches_database_target/);
  assert.match(sql, /idempotent_state_installed/);
  assert.match(sql, /installed_classifications as/);
  assert.match(sql, /count\(distinct eki\.id\)/);
  assert.match(sql, /installed_variants as/);
  assert.match(sql, /count\(distinct v\.id\)/);
  assert.match(sql, /duplicate_database_variant_keys as/);
  const classificationBlock = sql.match(/installed_classifications as \([\s\S]*?\n\), installed_variants as/)?.[0] ?? '';
  assert.doesNotMatch(classificationBlock, /event_kit_item_variants/);
  assert.match(sql, /6c931940-03ad-48c2-836c-754924a00d00/);
  assert.match(sql, /2b6aa3a1-3453-4486-9c6c-658e883fc209/);
  assert.match(sql, /planned_enabled_variant_count=15/);
  assert.match(sql, /active_shirt_events/);
  assert.match(sql, /shirt_supply_mode/);
  assert.match(sql, /uncovered_unclassified_count=0/);
  assert.doesNotMatch(sql, /and c\.unclassified_active_shirt_count=0/);
  assert.doesNotMatch(executableSql, /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i);
  assert.doesNotMatch(sql, /case[\s\S]{0,160}available_stock[\s\S]{0,160}(stock|made_to_order)/i);
});

test('preflight 104 nao multiplica uma classificacao pelas 15 variantes', () => {
  const joinedRows = Array.from({ length: 15 }, (_, index) => ({
    kit_item_id: '2b6aa3a1-3453-4486-9c6c-658e883fc209',
    variant_id: `variant-${index + 1}`,
  }));
  const installedClassificationCount = new Set(joinedRows.map((row) => row.kit_item_id)).size;
  const installedPlannedVariantCount = new Set(joinedRows.map((row) => row.variant_id)).size;
  assert.equal(installedClassificationCount, 1);
  assert.equal(installedPlannedVariantCount, 15);
});

test('edicao de cadastro separa sexo, financeiro e camiseta em contratos canonicos', async () => {
  const page = await readFile(new URL('../src/app/inscricoes/[id]/editar/page.tsx', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../src/app/inscricoes/[id]/editar/actions.ts', import.meta.url), 'utf8');
  assert.match(page, /value:"male",label:"Masculino"/);
  assert.match(page, /value:"female",label:"Feminino"/);
  assert.doesNotMatch(page, /name="gender"[^>]*<input/);
  assert.match(page, /paid:"Confirmado",pending:"Pendente"/);
  assert.doesNotMatch(page, /name="payment_status"|name="amount"|name="payment_method"/);
  assert.match(actions, /finalizeCadastroPaymentAndTicketAction/);
  assert.match(actions, /finance\.confirm_payment/);
  assert.doesNotMatch(actions, /from\("payments"\)\.update/);
  assert.doesNotMatch(actions, /payment_status:\s*payload/);
});

test('edicao carrega variantes 104, reage ao modelo e bloqueia camiseta entregue', async () => {
  const page = await readFile(new URL('../src/app/inscricoes/[id]/editar/page.tsx', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../src/app/inscricoes/[id]/editar/actions.ts', import.meta.url), 'utf8');
  assert.match(actions, /get_admin_ticket_shirt_options/);
  assert.match(actions, /admin_change_ticket_shirt/);
  assert.match(actions, /inventory\.change_participant_shirt/);
  assert.match(actions, /item\.item_type === "shirt" && item\.status === "delivered"/);
  assert.match(actions, /O tamanho não pode mais ser alterado porque este ingresso já teve kit entregue ou check-in realizado\./);
  assert.match(page, /shirtOptions\.filter\(option=>option\.shirt_type===shirtType\)/);
  assert.match(page, /setShirtType\(event\.target\.value\);setShirtSize\(""\)/);
  assert.match(page, /Sob encomenda/);
  assert.doesNotMatch(page, /SHIRT_SIZES|SHIRT_TYPES|EXGG/);
  assert.doesNotMatch(actions, /shirt_inventory|event_kit_item_variant_inventory/);
});

test('migration 105 protege busca e transferencia administrativa por UUID', async () => {
  const sql=await readFile(new URL('../supabase/migrations/105_canonical_admin_ticket_transfer_and_cancellation.sql',import.meta.url),'utf8');
  assert.match(sql,/search_admin_ticket_holder_candidates/);assert.match(sql,/length\(v_term\)<3/);
  assert.match(sql,/p_target_participant_id uuid/);assert.match(sql,/participants\.edit_basic/);assert.match(sql,/user_can_access_organization/);
  assert.match(sql,/update public\.order_items set participant_id=p_target_participant_id/);assert.match(sql,/update public\.tickets set participant_id=p_target_participant_id/);
  assert.match(sql,/update public\.participant_kit_items set participant_id=p_target_participant_id/);
  assert.match(sql,/v_previous=p_target_participant_id[\s\S]*changed',false/);
  assert.doesNotMatch(sql,/update public\.(orders|payments) set/);
});

test('migration 105 cancela ingresso e reservas com retry idempotente',async()=>{const sql=await readFile(new URL('../supabase/migrations/105_canonical_admin_ticket_transfer_and_cancellation.sql',import.meta.url),'utf8');assert.match(sql,/current_user_has_permission\('orders\.cancel'\)/);assert.match(sql,/status='used'[\s\S]*desfaça o check-in/);assert.match(sql,/status='delivered'[\s\S]*desfaça a entrega/);assert.match(sql,/if v_ticket\.status='cancelled' then return[\s\S]*changed',false/);assert.match(sql,/reserved_quantity=reserved_quantity-v_link\.quantity/);assert.match(sql,/update public\.participant_kit_items set status='cancelled'/);assert.match(sql,/admin_ticket_cancelled/);assert.doesNotMatch(sql,/delete from public\.(tickets|participant_kit_items)|payment_status='refunded'/);});

test('preflight 105 e somente leitura e bloqueia ambiguidades estruturais',async()=>{const sql=await readFile(new URL('../supabase/plans/105_canonical_admin_ticket_transfer_and_cancellation_preflight.sql',import.meta.url),'utf8');const executable=sql.replace(/--.*$/gm,'');assert.match(sql,/tickets_accept_cancelled/);assert.match(sql,/checkin_rejects_cancelled/);assert.match(sql,/ambiguous_ticket_kit_link_count/);assert.match(sql,/mismatched_ticket_order_item_kit_count/);assert.match(sql,/mismatched_ticket_participant_kit_count/);assert.match(sql,/invalid_variant_inventory_count/);assert.match(sql,/migration_105_idempotent_state/);assert.match(sql,/safe_to_apply/);assert.doesNotMatch(executable,/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i);});

test('preflight 105 usa o catalogo RBAC canonico e tolera ausencia estrutural de is_active',async()=>{const sql=await readFile(new URL('../supabase/plans/105_canonical_admin_ticket_transfer_and_cancellation_preflight.sql',import.meta.url),'utf8');assert.doesNotMatch(sql,/public\.permissions\b/);assert.match(sql,/public\.admin_permissions/);assert.match(sql,/information_schema\.columns[\s\S]*column_name='is_active'/);assert.match(sql,/to_jsonb\(ap\)->>'is_active'/);assert.match(sql,/resolve_user_permission\(uuid,text\)/);assert.match(sql,/current_user_has_permission\(text\)/);assert.match(sql,/user_can_access_organization\(uuid,uuid\)/);});

test('diagnostico 105 valida camiseta sob encomenda do ingresso sem alterar dados',async()=>{const sql=await readFile(new URL('../supabase/plans/105_ticket_made_to_order_shirt_link_diagnostic.sql',import.meta.url),'utf8');const executable=sql.replace(/--.*$/gm,'');const resolved=sql.match(/\), resolved as \(\s*select([\s\S]*?)\s+from expected x cross join target t/)?.[1]??'';assert.match(sql,/86825375-30c1-4e82-83ac-be080b2b1a5c/);assert.match(sql,/'Babylook'::text as shirt_type/);assert.match(sql,/'EXG'::text as shirt_size/);assert.match(sql,/'made_to_order'::text as supply_mode/);assert.match(sql,/order_item_shirt_type/);assert.match(sql,/participant_kit_item_id/);assert.match(sql,/variant_data/);assert.match(sql,/active_kit_item_count/);assert.match(sql,/ticket_kit_link_count/);assert.match(sql,/delivered_kit_link_count/);assert.match(sql,/movement_correlation_supported/);assert.match(sql,/shirt_synced/);assert.match(sql,/kit_has_four_items/);assert.match(sql,/shirt_not_delivered/);assert.match(sql,/made_to_order_did_not_reserve_stock/);assert.match(sql,/state_is_consistent/);assert.match(resolved,/t\.ticket_id/);assert.match(resolved,/x\.ticket_id as expected_ticket_id/);assert.doesNotMatch(resolved,/\b[tx]\.\*/);assert.doesNotMatch(sql,/\b(?:eki|v|pki|kc|vs|ls)\.\*/);assert.match(sql,/r\.ticket_id=r\.expected_ticket_id/);assert.match(sql,/r\.linked_ticket_id=r\.ticket_id/);for(const name of ['ticket_id','event_id','organization_id','order_item_id','participant_id'])assert.equal((resolved.match(new RegExp(`t\\.${name}(?=,|\\s)`, 'g'))??[]).length,1,`${name} real deve ser projetado uma unica vez de target`);assert.doesNotMatch(executable,/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i);});

test('diagnostico da linha do tempo 105 e somente leitura e verifica Babylook EXG',async()=>{const sql=await readFile(new URL('../supabase/plans/105_ticket_administrative_timeline_diagnostic.sql',import.meta.url),'utf8');const executable=sql.replace(/--.*$/gm,'');assert.match(sql,/86825375-30c1-4e82-83ac-be080b2b1a5c/);assert.match(sql,/available_history_and_audit_tables/);assert.match(sql,/ticket_issued_audit_count/);assert.match(sql,/payment_confirmation_audit_count/);assert.match(sql,/migration_104_babylook_exg_audit_exists/);assert.match(sql,/holder_history_count/);assert.match(sql,/kit_audit_count/);assert.match(sql,/checkin_audit_count/);assert.match(sql,/category_audit_count/);assert.match(sql,/resend_audit_count/);assert.match(sql,/cancellation_audit_count/);assert.match(sql,/active_canonical_operation_without_audit_detected/);assert.doesNotMatch(executable,/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i);});

test('diagnostico da timeline resolve camiseta 104 pelos UUIDs canonicos do payload',async()=>{const sql=await readFile(new URL('../supabase/plans/105_ticket_administrative_timeline_diagnostic.sql',import.meta.url),'utf8');const resolution=sql.match(/shirt_audit_resolution as \(([\s\S]*?)\), source_catalog/)?.[1]??'';const variantCount=sql.match(/\(select count\(distinct sar\.audit_log_id\)[\s\S]*?as babylook_exg_variant_audit_count/)?.[0]??'';assert.match(resolution,/\(al\.details->>'variant_id'\)::uuid/);assert.match(resolution,/\(al\.details->>'kit_item_id'\)::uuid/);assert.match(resolution,/eki\.id=parsed\.kit_item_id and eki\.event_id=t\.event_id/);assert.match(resolution,/e\.organization_id=t\.organization_id/);assert.match(resolution,/v\.id=parsed\.variant_id and v\.kit_item_id=eki\.id/);assert.match(variantCount,/resolved_shirt_type='Babylook'/);assert.match(variantCount,/resolved_shirt_size='EXG'/);assert.match(variantCount,/installed_supply_mode=sar\.audited_supply_mode/);assert.doesNotMatch(variantCount,/details->>'shirt_type'|details->>'shirt_size'/);assert.match(sql,/babylook_exg_variant_audit_count>0 as migration_104_babylook_exg_audit_exists|babylook_exg_direct_audit_count>0 or fc\.babylook_exg_variant_audit_count>0/);});

test('linha do tempo administrativa normaliza, deduplica, pagina e mascara dados',async()=>{const lib=await readFile(new URL('../src/lib/admin/ticket-timeline.ts',import.meta.url),'utf8');assert.match(lib,/ticket_holder_history/);assert.match(lib,/ticket_item_change_requests/);assert.match(lib,/audit_logs/);assert.match(lib,/issued_at/);assert.match(lib,/paid_at/);assert.match(lib,/deduplicateTicketTimelineEvents/);assert.match(lib,/pageSize/);assert.match(lib,/maskEmail/);assert.doesNotMatch(lib,/token|encrypted_password|refresh_token|access_token/);assert.match(lib,/ticketTimelineToCsv/);assert.match(lib,/ticketTimelineToPdf/);});

test('fonte secundaria da timeline degrada sem derrubar a ficha', async()=>{const warnings=[];const logs=[];const data=await loadOptionalTimelineSource('audit-logs',Promise.resolve({data:null,error:{code:'42703',message:'coluna ausente'}}),'ticket-test',warnings,(message,context)=>logs.push({message,context}));assert.equal(data,null);assert.deepEqual(warnings,['audit-logs']);assert.equal(logs.length,1);assert.match(logs[0].message,/ticket-timeline:audit-logs/);assert.equal(logs[0].context.code,'42703');});

test('timeline usa cadeia canonica e nao solicita audit_logs.actor',async()=>{const lib=await readFile(new URL('../src/lib/admin/ticket-timeline.ts',import.meta.url),'utf8');assert.match(lib,/from\("order_items"\)[\s\S]*canonicalOrderId[\s\S]*from\("orders"\)[\s\S]*from\("payments"\)/);assert.doesNotMatch(lib,/participants\(full_name\)|orders\(order_number|payments!orders_payment_id_fkey|id,actor,action/);assert.match(lib,/hasPartialHistory: warnings\.length > 0/);});

test('timeline preserva duas trocas consecutivas e deduplica somente a emissao',async()=>{const base={operator:'Sistema',reason:null,previousState:null,newState:null,source:'audit'};const rows=[{...base,id:'functional-issued',occurredAt:'2026-08-10T10:00:00.000Z',type:'ticket_issued',label:'Ingresso emitido',source:'functional',newState:'active',detail:null},{...base,id:'audit-issued',occurredAt:'2026-08-10T10:00:00.100Z',type:'ticket_issued',label:'Ingresso emitido',detail:null},{...base,id:'payment',occurredAt:'2026-08-10T10:01:00.000Z',type:'payment_confirmed',label:'Pagamento confirmado',source:'functional',detail:null},{...base,id:'shirt-exg',occurredAt:'2026-08-10T10:02:00.000Z',type:'ticket_shirt_admin_changed',label:'Camiseta alterada',detail:'Alterada para Babylook / EXG'},{...base,id:'shirt-pp',occurredAt:'2026-08-10T10:03:00.000Z',type:'ticket_shirt_admin_changed',label:'Camiseta alterada',detail:'Alterada para Camiseta / PP'}];const result=deduplicateTicketTimelineEvents(rows);assert.equal(result.length,4);assert.deepEqual(result.filter(row=>row.type==='ticket_shirt_admin_changed').map(row=>row.id),['shirt-exg','shirt-pp']);});

test('taxonomia separa ingresso, conta e auditoria tecnica',async()=>{const taxonomy=await readFile(new URL('../src/lib/admin/ticket-event-taxonomy.ts',import.meta.url),'utf8');for(const action of ['ticket_issued','ticket_shirt_admin_changed','participant_data_issues_reevaluated','participant_account_invite_claimed','imported_participant_issue_finalized','admin_ticket_holder_transferred','ticket_category_changed','ticket_resent','ticket_checkin_entry','ticket_kit_item_delivered','admin_ticket_cancelled'])assert.match(taxonomy,new RegExp(`${action}:`));assert.match(taxonomy,/accountOnly/);assert.match(taxonomy,/ticketAndAccount/);assert.doesNotMatch(taxonomy,/Ação administrativa registrada/);});

test('interface da timeline preserva escopo e oculta transicao inexistente',async()=>{const panel=await readFile(new URL('../src/app/ingressos/[ticketId]/timeline-panel.tsx',import.meta.url),'utf8');assert.match(panel,/Este ingresso/);assert.match(panel,/Histórico completo da conta/);assert.match(panel,/name="eventId"/);assert.match(panel,/canonicalQuery\.set\("scope", result\.scope\)/);assert.match(panel,/event\.hasTransition/);assert.doesNotMatch(panel,/event\.previousState\|\|event\.newState/);assert.match(panel,/Existem \{result\.technicalEventCount\} registros técnicos adicionais/);assert.match(panel,/Auditoria técnica/);assert.match(panel,/result\.canViewTechnicalAudit/);});

test('exportacoes registram escopo filtros e incluem auditoria tecnica autorizada',async()=>{const timeline=await readFile(new URL('../src/lib/admin/ticket-timeline.ts',import.meta.url),'utf8');const route=await readFile(new URL('../src/app/api/ingressos/[ticketId]/historico/[format]/route.ts',import.meta.url),'utf8');assert.match(timeline,/\["Escopo"/);assert.match(timeline,/\["Filtro de evento"/);assert.match(timeline,/result\.canViewTechnicalAudit \? \[\.\.\.result\.events, \.\.\.result\.technicalEvents\]/);assert.match(route,/const scope = rawScope === 'account' \? 'account' : 'ticket'/);assert.match(route,/p_filter_event_id:result\.appliedEventId/);assert.match(route,/hasPermission\('audit\.view'\)/);});

test('todos os estados canonicos da timeline possuem rotulo seguro',()=>{const expected={active:'Ativo',approved:'Aprovado',assigned:'Atribuído',cancelled:'Cancelado',canceled:'Cancelado',claimed:'Reivindicado',completed:'Concluído',confirmed:'Confirmado',delivered:'Entregue',duplicate:'Duplicado',expired:'Expirado',failed:'Falhou',inactive:'Inativo',issued:'Emitido',missing:'Não existente',not_issued:'Não emitido',open:'Aberto',paid:'Confirmado',pending:'Pendente',processing:'Em processamento',refunded:'Reembolsado',rejected:'Rejeitado',reserved:'Reservado',resolved:'Resolvido',revoked:'Revogado',transferred:'Transferido',unassigned:'Sem titular',used:'Utilizado'};assert.deepEqual(TIMELINE_STATE_LABELS,expected);for(const [raw,label] of Object.entries(expected))assert.equal(getTimelineStateLabel(raw),label);});

test('estado desconhecido nunca e exibido cru e gera aviso seguro',()=>{const logs=[];assert.equal(getTimelineStateLabel('internal_future_state',{eventType:'test',field:'newState',log:message=>logs.push(message)}),'Estado não reconhecido');assert.equal(getTimelineStateLabel('d006d054-4442-4f5b-9e3f-e403361201f0',{log:message=>logs.push(message)}),'Referência registrada');assert.equal(logs.length,2);assert.doesNotMatch(logs.join(' '),/internal_future_state|d006d054/);});

test('timeline localiza cabecalho e transicoes antes da interface e exportacao',async()=>{const timeline=await readFile(new URL('../src/lib/admin/ticket-timeline.ts',import.meta.url),'utf8');assert.match(timeline,/getTimelineStateLabel\(item\.previousState/);assert.match(timeline,/getTimelineStateLabel\(item\.newState/);assert.match(timeline,/status: getTimelineStateLabel\(String\(ticket\.status\)/);assert.match(timeline,/previousState: "pending", newState: String\(payment\?\.payment_status \?\? "paid"\)/);});

test('conta sem eventId usa todos os eventos sem fallback do ingresso',async()=>{const timeline=await readFile(new URL('../src/lib/admin/ticket-timeline.ts',import.meta.url),'utf8');assert.match(timeline,/let appliedEventId: string \| null = null/);assert.match(timeline,/scope === "account" && filters\.eventId/);assert.match(timeline,/!appliedEventId \|\| item\.eventId === appliedEventId/);assert.doesNotMatch(timeline,/appliedEventId[^\n]*ticket\.event_id/);});

test('conta aceita somente evento valido da organizacao',async()=>{const timeline=await readFile(new URL('../src/lib/admin/ticket-timeline.ts',import.meta.url),'utf8');assert.match(timeline,/from\("events"\)\.select\("id,name"\)\.eq\("id", filters\.eventId\)\.eq\("organization_id", organizationId\)/);assert.match(timeline,/appliedEventId = selectedEvent\.id/);assert.match(timeline,/ticket-timeline:invalid-event-filter/);assert.match(timeline,/if \(appliedEventId\) accountAuditQuery = accountAuditQuery\.eq\("event_id", appliedEventId\)/);});

test('alternancia de escopo limpa evento e reinicia pagina',async()=>{const panel=await readFile(new URL('../src/app/ingressos/[ticketId]/timeline-panel.tsx',import.meta.url),'utf8');assert.match(panel,/next\.set\("scope", scope\)[\s\S]*next\.delete\("page"\)[\s\S]*next\.delete\("eventId"\)/);assert.match(panel,/Eventos: Todos os eventos/);assert.match(panel,/Evento filtrado:/);assert.match(panel,/<option value="">Todos os eventos<\/option>/);});

test('cabecalho e exportacao da conta nao fingem ingresso ou pedido unico',async()=>{const panel=await readFile(new URL('../src/app/ingressos/[ticketId]/timeline-panel.tsx',import.meta.url),'utf8');const timeline=await readFile(new URL('../src/lib/admin/ticket-timeline.ts',import.meta.url),'utf8');assert.match(panel,/result\.scope\s*===\s*"ticket"\s*\?/);assert.match(timeline,/result\.scope === "account"[\s\S]*\["Conta de", result\.header\.holderName\]/);assert.match(timeline,/Filtro de evento[\s\S]*Todos os eventos/);assert.match(timeline,/contextLines = result\.scope === "account"/);});

test('exportacoes distinguem todos os eventos de um evento explicito',async()=>{const timeline=await readFile(new URL('../src/lib/admin/ticket-timeline.ts',import.meta.url),'utf8');const route=await readFile(new URL('../src/app/api/ingressos/[ticketId]/historico/[format]/route.ts',import.meta.url),'utf8');assert.match(timeline,/result\.appliedEventId \? result\.header\.filteredEventName \?\? "Evento filtrado" : "Todos os eventos"/);assert.match(route,/const eventId = sanitizedUuid\(url\.searchParams\.get\('eventId'\)\)/);assert.match(route,/scope !== 'account'/);assert.match(route,/result\.appliedEventId !== eventId/);});

test('filtro Tipo usa codigos canonicos e rotulos portugueses do F2',()=>{const options=timelineTypeOptions(['ticket_issued','payment_confirmed','ticket_shirt_admin_changed']);assert.deepEqual(options.map(option=>option.code).sort(),['payment_confirmed','ticket_issued','ticket_shirt_admin_changed']);assert.deepEqual(new Set(options.map(option=>option.label)),new Set(['Ingresso emitido','Pagamento confirmado','Camiseta alterada']));});

test('tipos da conta e registros tecnicos usam a taxonomia central',()=>{const options=timelineTypeOptions(['participant_account_invite_claimed','participant_data_issues_reevaluated','imported_participant_issue_finalized','future_internal_action'],true);assert.ok(options.some(option=>option.code==='participant_account_invite_claimed'&&option.label==='Primeiro acesso confirmado'));assert.ok(options.some(option=>option.code==='participant_data_issues_reevaluated'&&option.label==='Pendências cadastrais reavaliadas'));assert.ok(options.some(option=>option.code==='__technical__'&&option.label==='Outros registros técnicos'));assert.ok(!options.some(option=>option.code==='future_internal_action'));});

test('selects restauram somente filtros validados e transicao usa estado bruto canonico',async()=>{const panel=await readFile(new URL('../src/app/ingressos/[ticketId]/timeline-panel.tsx',import.meta.url),'utf8');const timeline=await readFile(new URL('../src/lib/admin/ticket-timeline.ts',import.meta.url),'utf8');assert.match(panel,/Todos os tipos/);assert.match(panel,/value=\{option\.code\}>\{option\.label\}/);assert.match(panel,/key=\{result\.appliedTypeCode\s*\?\?\s*"all-types"\}/);assert.match(panel,/defaultValue=\{result\.appliedTypeCode\s*\?\?\s*""\}/);assert.match(panel,/key=\{result\.appliedEventId\s*\?\?\s*"all-events"\}/);assert.match(panel,/defaultValue=\{result\.appliedEventId\s*\?\?\s*""\}/);assert.match(panel,/event\.hasTransition/);assert.doesNotMatch(panel,/previousState\?\?"Não informado"|newState\?\?"Não informado"/);assert.match(timeline,/isCanonicalTimelineState\(item\.previousState\) && isCanonicalTimelineState\(item\.newState\)/);assert.match(timeline,/typeContextEvents = normalized\.filter/);assert.match(timeline,/Filtro de tipo/);});

test('navegacao da timeline usa App Router sem alterar scroll',async()=>{const panel=await readFile(new URL('../src/app/ingressos/[ticketId]/timeline-panel.tsx',import.meta.url),'utf8');assert.match(panel,/usePathname, useRouter, useSearchParams/);assert.match(panel,/useTransition\(\)/);assert.match(panel,/router\[mode\]\(target, \{ scroll: false \}\)/);assert.match(panel,/navigate\(next, "replace", control\)/);assert.match(panel,/navigate\(next, "push", control\)/);assert.doesNotMatch(panel,/window\.location|method="get"|router\.push\(`\?\$\{/);});

test('escopo filtros e paginacao reiniciam e preservam parametros canonicos',async()=>{const panel=await readFile(new URL('../src/app/ingressos/[ticketId]/timeline-panel.tsx',import.meta.url),'utf8');assert.match(panel,/new URLSearchParams\(currentSearchParams\.toString\(\)\)/);assert.match(panel,/next\.set\("scope", scope\)/);assert.match(panel,/next\.delete\("eventId"\)/);assert.match(panel,/next\.delete\("page"\)/);assert.match(panel,/event\.preventDefault\(\)/);assert.match(panel,/allowedTypes\.has\(type\)/);assert.match(panel,/allowedEvents\.has\(eventId\)/);assert.match(panel,/next\.set\("page", String\(page\)\)/);assert.match(panel,/onSubmit=\{applyFilters\}/);});

test('timeline mantem dados e bloqueia controles durante transicao acessivel',async()=>{const panel=await readFile(new URL('../src/app/ingressos/[ticketId]/timeline-panel.tsx',import.meta.url),'utf8');assert.match(panel,/id="historico"/);assert.match(panel,/aria-busy=\{isPending\}/);assert.match(panel,/aria-live="polite"/);assert.match(panel,/Atualizando histórico…/);assert.match(panel,/if \(isPending\) return/);assert.match(panel,/disabled=\{controlsDisabled/);assert.match(panel,/focus\(\{ preventScroll: true \}\)/);assert.match(panel,/Não foi possível atualizar o histórico/);assert.match(panel,/Tentar novamente/);assert.match(panel,/lastTarget/);});

test('migration 106 prepara leitor protegido e auditoria futura sem backfill',async()=>{const migration=await readFile(new URL('../supabase/migrations/106_protected_admin_ticket_audit_timeline.sql',import.meta.url),'utf8');const preflight=await readFile(new URL('../supabase/plans/106_protected_admin_ticket_audit_timeline_preflight.sql',import.meta.url),'utf8');assert.match(migration,/security definer set search_path=public,pg_temp/);assert.match(migration,/current_user_has_permission\('participants\.view'\)/);assert.match(migration,/user_can_access_organization\(v_actor,v_ticket\.organization_id\)/);assert.match(migration,/previous_variant_id/);assert.match(migration,/new_variant_id/);assert.doesNotMatch(migration,/update public\.audit_logs|insert into public\.audit_logs[\s\S]*ticket_shirt_admin_changed/);assert.match(preflight,/target_audit_count=3/);assert.match(preflight,/shirt_change_count=2/);assert.match(preflight,/safe_to_apply/);assert.doesNotMatch(preflight,/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b\s+(table|public\.)/i);});

test('exportacao de historico revalida RBAC, organizacao e registra auditoria no servidor',async()=>{const route=await readFile(new URL('../src/app/api/ingressos/[ticketId]/historico/[format]/route.ts',import.meta.url),'utf8');assert.match(route,/hasPermission\("orders\.view"\)/);assert.match(route,/hasPermission\("participants\.view"\)/);assert.match(route,/getCurrentOrganizationContext/);assert.match(route,/getAdministrativeTicketTimeline/);assert.match(route,/rpc\('record_ticket_history_export'/);assert.match(route,/auditError \|\| !audit\?\.audit_id \|\| !audit\?\.audited_at/);assert.match(route,/application\/pdf/);assert.match(route,/text\/csv/);assert.doesNotMatch(route,/from\(['"]audit_logs['"]\)\.insert|service.?role|token|cpf|password/i);});

test('migration 107 audita exportacao por RPC protegido sem confiar em identidade externa',async()=>{const migration=await readFile(new URL('../supabase/migrations/107_record_ticket_history_export.sql',import.meta.url),'utf8');assert.match(migration,/security definer[\s\S]*set search_path=public,pg_temp/);assert.match(migration,/v_actor uuid:=auth\.uid\(\)/);assert.match(migration,/v_audited_at timestamptz:=now\(\)/);assert.match(migration,/current_user_has_permission\('participants\.view'\)/);assert.match(migration,/current_user_has_permission\('orders\.view'\)/);assert.match(migration,/current_user_has_permission\('audit\.view'\)/);assert.match(migration,/user_can_access_organization\(v_actor,v_ticket\.organization_id\)/);assert.match(migration,/v_format not in\('pdf','csv'\)/);assert.match(migration,/v_scope not in\('ticket','account'\)/);assert.match(migration,/jsonb_strip_nulls/);assert.match(migration,/ticket_history_exported/);assert.match(migration,/position\('service_role' in v_definition\)>0/);assert.doesNotMatch(migration,/p_action|p_actor|p_operator|p_created_at|['"](?:token|cpf|email|content)['"]/i);});

test('preflight 107 e somente leitura e aceita estado anterior ou instalado',async()=>{const sql=await readFile(new URL('../supabase/plans/107_record_ticket_history_export_preflight.sql',import.meta.url),'utf8');const executable=sql.replace(/--.*$/gm,'');assert.match(sql,/audit_logs_structure_ok/);assert.match(sql,/tickets_structure_ok/);assert.match(sql,/events_structure_ok/);assert.match(sql,/has_participants_view/);assert.match(sql,/has_orders_view/);assert.match(sql,/has_audit_view/);assert.match(sql,/conflicting_signature_count/);assert.match(sql,/d\.body='' or/);assert.match(sql,/signature_is_installable/);assert.match(sql,/safe_to_apply/);assert.doesNotMatch(executable,/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i);});

test('migration e preflight 107 usam as sete colunas reais de audit_logs',async()=>{const migration=await readFile(new URL('../supabase/migrations/107_record_ticket_history_export.sql',import.meta.url),'utf8');const preflight=await readFile(new URL('../supabase/plans/107_record_ticket_history_export_preflight.sql',import.meta.url),'utf8');const insertColumns=migration.match(/insert into public\.audit_logs\(([^)]+)\)/i)?.[1]??'';assert.equal(insertColumns.replace(/\s+/g,''),'id,action,entity_type,entity_id,event_id,details,created_at');assert.match(migration,/'actor_user_id',v_actor/);assert.doesNotMatch(insertColumns,/(^|,)actor(,|$)/);assert.doesNotMatch(migration,/alter\s+table\s+public\.audit_logs|add\s+column/i);assert.match(preflight,/column_name in\('id','action','entity_type','entity_id','event_id','details','created_at'\)\)=7/);assert.match(preflight,/installed_function_references_audit_logs_actor/);assert.match(preflight,/installed_payload_uses_actor_user_id/);assert.doesNotMatch(preflight,/column_name in\([^\n]*'actor'/);});

test('rota 107 nao recebe operador nem grava audit_logs diretamente',async()=>{const route=await readFile(new URL('../src/app/api/ingressos/[ticketId]/historico/[format]/route.ts',import.meta.url),'utf8');const migration=await readFile(new URL('../supabase/migrations/107_record_ticket_history_export.sql',import.meta.url),'utf8');assert.doesNotMatch(route,/from\(['"]audit_logs['"]\)|\.insert\(/);assert.match(route,/rpc\('record_ticket_history_export'/);assert.doesNotMatch(route,/p_(?:actor|operator|action|created_at)/i);assert.doesNotMatch(migration,/\bp_(?:actor|operator|action|created_at)\b/i);assert.match(migration,/v_actor uuid:=auth\.uid\(\)/);});

test('formatador compartilhado usa America Sao Paulo sem fracao ou offset tecnico',()=>{const value='2026-08-11T15:04:05.987654Z';assert.equal(formatReportDateTime(value),'11/08/2026 às 12:04:05');assert.equal(reportIsoDateTime(value),'2026-08-11T15:04:05.987Z');assert.doesNotMatch(formatReportDateTime(value),/T|Z|[+-]\d\d:\d\d|\.\d{3}/);});

test('tema de relatorio tem pagina branca contraste e destaque Militrin acessiveis',()=>{assert.deepEqual(REPORT_THEME.colors.white,[255,255,255]);assert.deepEqual(REPORT_THEME.colors.text,[31,41,55]);assert.deepEqual(REPORT_THEME.colors.green,[4,120,87]);const luminance=([r,g,b])=>{const f=v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4};return .2126*f(r)+.7152*f(g)+.0722*f(b)};const contrast=(a,b)=>(Math.max(luminance(a),luminance(b))+.05)/(Math.min(luminance(a),luminance(b))+.05);assert.ok(contrast(REPORT_THEME.colors.text,REPORT_THEME.colors.white)>=7);assert.ok(contrast(REPORT_THEME.colors.green,REPORT_THEME.colors.white)>=4.5);});

test('UUID completo quebra com seguranca sem perder rastreabilidade',()=>{const uuid='86825375-30c1-4e82-83ac-be080b2b1a5c';const lines=splitTechnicalIdentifier(uuid,18);assert.equal(lines.join(''),uuid);assert.ok(lines.every(line=>line.length<=18));});

test('historico PDF CSV e print usam o tema compartilhado e paginacao A4',async()=>{const timeline=await readFile(new URL('../src/lib/admin/ticket-timeline.ts',import.meta.url),'utf8');const panel=await readFile(new URL('../src/app/ingressos/[ticketId]/timeline-panel.tsx',import.meta.url),'utf8');const ticket=await readFile(new URL('../src/components/public/TicketPdfButton.tsx',import.meta.url),'utf8');const receipt=await readFile(new URL('../src/components/public/PaymentReceiptPdfButton.tsx',import.meta.url),'utf8');for(const source of [timeline,ticket,receipt]){assert.match(source,/applyReportPage/);assert.match(source,/finalizeReportPages/);}assert.match(timeline,/formatReportDateTime\(item\.occurredAt\)/);assert.match(timeline,/if \(y \+ height > page\.height - page\.bottom - 12\) addPage\(\)/);assert.match(timeline,/Data\/hora ISO/);assert.match(timeline,/Código do tipo/);assert.match(timeline,/\\uFEFF/);assert.doesNotMatch(timeline,/setFillColor\(9, 16, 33\)|setFillColor\(15, 23, 42\)/);assert.match(panel,/@page \{ size:A4/);assert.match(panel,/page-break-inside:avoid/);assert.match(panel,/report-technical-id/);assert.match(panel,/America\/Sao_Paulo/);});

test('relatorio preserva acentos e separa operador motivo e alteracao',async()=>{const timeline=await readFile(new URL('../src/lib/admin/ticket-timeline.ts',import.meta.url),'utf8');const panel=await readFile(new URL('../src/app/ingressos/[ticketId]/timeline-panel.tsx',import.meta.url),'utf8');for(const label of ['Descrição','Alteração','Responsável','Código do tipo'])assert.match(timeline,new RegExp(label));assert.match(panel,/>Realizado por:<\/span>/);assert.match(panel,/>Motivo:<\/span>/);assert.match(panel,/>Alteração:<\/span>/);assert.doesNotMatch(timeline,/Operador:.*\|.*Motivo:/);});

test('interface administrativa oferece filtros, impressao e exportacoes do historico',async()=>{const panel=await readFile(new URL('../src/app/ingressos/[ticketId]/timeline-panel.tsx',import.meta.url),'utf8');const page=await readFile(new URL('../src/app/ingressos/[ticketId]/page.tsx',import.meta.url),'utf8');assert.match(panel,/Imprimir histórico/);assert.match(panel,/Exportar PDF/);assert.match(panel,/Exportar CSV/);assert.match(panel,/type="date"/);assert.match(panel,/@media print/);assert.match(panel,/Página \{result\.page\}/);assert.match(page,/getAdministrativeTicketTimeline/);assert.match(page,/organization\.id/);});

test('XLSX do histórico possui duas abas, estilos, filtros, congelamento e datas reais', async () => {
  const ticketId='86825375-30c1-4e82-83ac-be080b2b1a5c';
  const result={header:{ticketId,eventName:'Militrin 2026',orderNumber:'MIL-2026-0042',holderName:'João da Silva',status:'Ativo',organizationId:'11111111-1111-4111-8111-111111111111',eventId:'22222222-2222-4222-8222-222222222222',filteredEventName:null},events:[{id:'audit-1',occurredAt:'2026-08-11T15:04:05.987Z',type:'payment_confirmed',label:'Pagamento confirmado',previousState:'Pendente',newState:'Confirmado',operator:'Op***@militrin.com.br',reason:'Conferência administrativa',detail:null,description:'Pagamento associado ao pedido confirmado.',category:'pagamento',eventId:'22222222-2222-4222-8222-222222222222',relatedTicketId:ticketId,relatedOrderId:'33333333-3333-4333-8333-333333333333',source:'audit',hasTransition:true}],total:1,page:1,pageSize:25,availableTypes:[],hasPartialHistory:false,scope:'ticket',appliedEventId:null,appliedTypeCode:null,appliedTypeLabel:null,technicalEvents:[],technicalEventCount:0,canViewTechnicalAudit:false,availableEvents:[{id:'22222222-2222-4222-8222-222222222222',name:'Militrin 2026'}],generatedAt:'2026-08-11T15:04:05.987Z'};
  const buffer=await ticketTimelineToXlsx(result,result.generatedAt,'ad***@militrin.com.br');
  const workbook=new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
  assert.deepEqual(workbook.worksheets.map((sheet)=>sheet.name),['Resumo','Histórico']);
  const summary=workbook.getWorksheet('Resumo'); const history=workbook.getWorksheet('Histórico');
  assert.equal(summary.getCell('A1').value,'Histórico administrativo Militrin');
  assert.equal(summary.getCell('A1').fill.fgColor.argb,'FF047857');
  assert.ok(history.autoFilter==='A1:R1'||(history.autoFilter.from==='A1'&&history.autoFilter.to==='R1'));
  assert.equal(history.views[0].state,'frozen'); assert.equal(history.views[0].ySplit,1);
  assert.equal(history.getCell('A2').value instanceof Date,true); assert.equal(history.getCell('A2').numFmt,'dd/mm/yyyy hh:mm:ss');
  assert.equal(history.getCell('B2').value,'Pagamento confirmado'); assert.equal(history.getCell('C2').value,'Pagamento associado ao pedido confirmado.');
  assert.equal(history.getColumn(12).hidden,true); assert.equal(history.getColumn(13).hidden,true);
  assert.equal(history.pageSetup.orientation,'landscape'); assert.equal(history.pageSetup.printTitlesRow,'1:1');
  assert.match(String(history.getCell('G2').value),/Conferência/);
  const crossReader=XLSX.read(buffer,{type:'buffer',cellDates:true});
  assert.deepEqual(crossReader.SheetNames,['Resumo','Histórico']);
  const accountResult={...result,scope:'account',appliedEventId:result.header.eventId,header:{...result.header,filteredEventName:'Militrin 2026'}};
  const accountWorkbook=new ExcelJS.Workbook(); await accountWorkbook.xlsx.load(await ticketTimelineToXlsx(accountResult,result.generatedAt,'ad***@militrin.com.br'));
  assert.equal(accountWorkbook.getWorksheet('Resumo').getCell('B4').value,'Conta inteira');
  assert.equal(accountWorkbook.getWorksheet('Resumo').getCell('B5').value,'Militrin 2026');
  assert.equal(accountWorkbook.getWorksheet('Resumo').getCell('B8').value,'Não se aplica ao escopo da conta');
});

test('rota e migration 108 liberam XLSX somente após auditoria protegida', async()=>{const route=await readFile(new URL('../src/app/api/ingressos/[ticketId]/historico/[format]/route.ts',import.meta.url),'utf8');const panel=await readFile(new URL('../src/app/ingressos/[ticketId]/timeline-panel.tsx',import.meta.url),'utf8');const migration=await readFile(new URL('../supabase/migrations/108_allow_xlsx_ticket_history_export.sql',import.meta.url),'utf8');const preflight=await readFile(new URL('../supabase/plans/108_allow_xlsx_ticket_history_export_preflight.sql',import.meta.url),'utf8');const functionBody=migration.match(/create or replace function[\s\S]*?as \$\$([\s\S]*?)\$\$;/i)?.[1]??'';assert.match(route,/rpc\('record_ticket_history_export'/);assert.ok(route.indexOf("auditError || !audit?.audit_id")<route.indexOf("format==='xlsx'"));assert.match(route,/ticketTimelineToXlsx/);assert.match(route,/application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);assert.match(panel,/Exportar Excel/);assert.match(functionBody,/v_format not in\('pdf','csv','xlsx'\)/);assert.match(migration,/security definer[\s\S]*set search_path=public,pg_temp/);assert.match(functionBody,/'actor_user_id',v_actor/);assert.doesNotMatch(functionBody,/service_role|p_actor|p_operator|audit_logs\(id,actor,/i);const executable=preflight.replace(/--.*$/gm,'');assert.match(preflight,/xlsx_format_already_installed/);assert.match(preflight,/safe_to_apply/);assert.doesNotMatch(executable,/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i);});

test('reenvio futuro de ingresso passa a registrar fato auditavel',async()=>{const actions=await readFile(new URL('../src/app/inscricoes/actions.ts',import.meta.url),'utf8');const resend=actions.slice(actions.indexOf('export async function resendParticipantTicketAction'),actions.indexOf('export async function updateParticipantPaymentStatusAction'));assert.match(resend,/sendTicketConfirmation/);assert.match(resend,/action: "ticket_resent"/);assert.match(resend,/entity_type: "tickets"/);assert.match(resend,/actor_user_id/);});

test('interface editar ingresso limita-se a titularidade e cancelamento',async()=>{const page=await readFile(new URL('../src/app/ingressos/[ticketId]/editar/ticket-ownership-editor.tsx',import.meta.url),'utf8');const detail=await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx',import.meta.url),'utf8');assert.match(detail,/\/ingressos\/\$\{ticketId\}\/editar/);assert.match(page,/Titular atual/);assert.match(page,/Comprador do pedido \(somente leitura\)/);assert.match(page,/Nome, e-mail, CPF ou PIN/);assert.match(page,/Motivo obrigatório/);assert.match(page,/Transferir titularidade/);assert.match(page,/Cancelar ingresso/);assert.doesNotMatch(page,/Cidade|Telefone|Sexo|Forma de pagamento|Modelo|Tamanho/);});

test('migration 104 separa estoque e sob encomenda e bloqueia troca apos entrega', async () => {
  const sql = await readFile(new URL('../supabase/migrations/104_explicit_event_shirt_supply_mode.sql', import.meta.url), 'utf8');
  assert.match(sql, /shirt_supply_mode in\('stock','made_to_order','disabled'\)/);
  assert.match(sql, /shirt_supply_mode='made_to_order'/);
  assert.match(sql, /shirt_supply_mode='stock'/);
  assert.match(sql, /status='delivered'[\s\S]*operacao explicita de troca ou estorno/);
  assert.match(sql, /current_user_has_permission\('inventory\.change_participant_shirt'\)/);
  assert.match(sql, /user_can_access_organization/);
  assert.match(sql, /participant_kit_items[\s\S]*order_items[\s\S]*audit_logs/);
  assert.match(sql, /coalesce\(pki\.status,'not_linked'\)/);
  assert.match(sql, /Sob encomenda/);
  assert.match(sql, /v_event_id constant uuid:='6c931940-03ad-48c2-836c-754924a00d00'/);
  assert.match(sql, /v_kit_item_id constant uuid:='2b6aa3a1-3453-4486-9c6c-658e883fc209'/);
  assert.match(sql, /shirt_supply_mode='made_to_order'/);
  assert.match(sql, /\('Camiseta','EXGG',80\)/);
  assert.match(sql, /\('Babylook','EXG',170\)/);
  assert.match(sql, /count\(\*\)[\s\S]*<>15/);
  const planBlock = sql.match(/do \$plan\$[\s\S]*?\$plan\$;/)?.[0] ?? '';
  assert.doesNotMatch(planBlock, /public\.(shirt_inventory|event_kit_item_variant_inventory)/i);
  assert.doesNotMatch(sql, /limit_shirt_selection_to_stock/);
});

test('Inscricoes nao oferece mais mutacoes inline de pagamento ou ingresso', async () => {
  const list = await readFile(new URL('../src/app/inscricoes/page.tsx', import.meta.url), 'utf8');
  const detail = await readFile(new URL('../src/app/inscricoes/[id]/page.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(list, /PaymentStatusDialog|confirmParticipantPaymentAction|resendParticipantTicketAction/);
  assert.doesNotMatch(detail, /['"]use server['"]|confirmParticipantPaymentAction|resendParticipantTicketAction|changeParticipantShirtAction/);
  assert.match(list, /redirect\(`\/cadastros/);
  assert.match(detail, /Gerenciar pagamento e ingresso em Cadastros/);
});

test('Cadastros exibe somente acoes coerentes com materializacao do ingresso', async () => {
  const ui = await readFile(new URL('../src/app/cadastros/cadastro-list.tsx', import.meta.url), 'utf8');
  for (const label of ['Emitir ingresso', 'Editar cadastro', 'Ver ficha e ingressos']) assert.match(ui, new RegExp(label));
  assert.doesNotMatch(ui, /Confirmar pagamento/);
  assert.doesNotMatch(ui, /Visualizar QR|Reenviar ingresso/);
  assert.match(ui, /ticketCount/);
  assert.match(ui, /eventCount/);
});

test('Cadastros resolve o nome do lote comercial por registration_batches', async () => {
  const page = await readFile(new URL('../src/app/cadastros/[id]/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /registration_batches\(name\)/);
  assert.match(page, /groupContactTickets/);
});

test('ingressos administrativos filtram userId pela titularidade canonica', async () => {
  const page = await readFile(new URL('../src/app/ingressos/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /from\("participants"\)[\s\S]*\.eq\("user_id", params\.userId\)/);
  assert.match(page, /\.in\("participant_id", holderParticipantIds\)/);
  assert.doesNotMatch(page, /orders[^\n]*user_id/);
  assert.match(page, /\.eq\("organization_id", organization\.id\)/);
  assert.match(page, /requireAnyPermission/);
});

test('ticketId administrativo abre ficha unica protegida pela organizacao', async () => {
  const page = await readFile(new URL('../src/app/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /\.eq\("id", resolved\.ticketId\)\.eq\("organization_id", organization\.id\)\.maybeSingle\(\)/);
  assert.match(page, /requireAnyPermission/);
  assert.match(page, /TicketDetailPage/);
  assert.match(page, /if \(!data\) redirect\("\/acesso-negado"\)/);
});

test('ficha administrativa preserva campos imutaveis e operacoes protegidas', async () => {
  const detail = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
  for (const field of ['Evento', 'Titular', 'Comprador', 'Categoria', 'Lote', 'Pedido', 'Pagamento', 'Camiseta', 'Status check-in', 'Histórico']) assert.match(detail, new RegExp(field, 'i'));
  for (const permission of ['participants.edit_basic', 'inventory.change_participant_shirt', 'kits.deliver', 'checkin.scan']) assert.match(detail, new RegExp(permission.replace('.', '\\.')));
  assert.doesNotMatch(detail, /name=["'](?:event_id|order_id|payment_id|token|batch_id|unit_price|final_amount)["']/);
});

test('ficha do ingresso respeita estados concluídos e permissões de reversão operacional', async () => {
  const page = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
  const controls = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/ticket-operational-controls.tsx', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../src/app/operacoes/actions.ts', import.meta.url), 'utf8');
  assert.match(page, /kitFullyDelivered/);
  assert.match(page, /checkinDone/);
  assert.match(page, /TicketOperationalControls/);
  assert.match(controls, /Kit entregue/);
  assert.match(controls, /Check-in realizado/);
  assert.match(controls, /Reverter entrega do kit/);
  assert.match(controls, /Desfazer check-in/);
  assert.match(controls, /canDeliverKit && !props\.kitFullyDelivered/);
  assert.match(controls, /canCheckin && !props\.checkinDone/);
  assert.match(controls, /aria-live="polite"/);
  assert.match(controls, /setResult\(response\)/);
  assert.match(actions, /assertPermission\("kits\.undo_delivery"\)/);
  assert.match(actions, /rpc\("undo_ticket_full_kit"/);
  assert.match(actions, /assertPermission\("checkin\.undo"\)/);
  assert.match(actions, /rpc\("undo_ticket_checkin"/);
  assert.match(actions, /checkinEntryAction[\s\S]*?revalidatePath\(`\/ingressos\/\$\{ticketId\}`\)/);
  assert.match(actions, /deliverFullKitAction[\s\S]*?revalidatePath\(`\/ingressos\/\$\{payload\.ticket_id\}`\)/);
  assert.match(actions, /deliverKitAndCheckinAction[\s\S]*?revalidatePath\(`\/ingressos\/\$\{payload\.ticket_id\}`\)/);
});

test('Cadastros aponta para ficha administrativa e QR do mesmo ticket', async () => {
  const ui = await readFile(new URL('../src/app/cadastros/[id]/page.tsx', import.meta.url), 'utf8');
  assert.match(ui, /href=\{`\/ingressos\/\$\{ticket\.ticketId\}\?from=cadastro&contactId=\$\{id\}`\}/);
  assert.doesNotMatch(ui, /order\("issued_at"[\s\S]*limit\(1\)/);
});

test('diagnostico teste02 e estritamente somente leitura', async () => {
  const sql = await readFile(new URL('../supabase/plans/103_teste02_duplicate_orders_diagnostic.sql', import.meta.url), 'utf8');
  assert.match(sql, /teste02/i);
  assert.match(sql, /commercial_batch_id/);
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate|alter|drop|create)\b/i);
});

test('mapeamento usa labels amigaveis e reconhece aliases normalizados', () => {
  assert.equal(CANONICAL_FIELD_LABELS.full_name, 'Nome completo');
  assert.equal(CANONICAL_FIELD_LABELS.payment_method, 'Forma de pagamento');

  const mapping = inferColumnMapping([
    'NOME', 'CPF', 'E-mail', 'WhatsApp', 'Data de nascimento', 'Sexo', 'Cidade',
    'Evento', 'Ano do evento', 'Categoria do ingresso', 'Lote', 'Tipo de camiseta',
    'Tamanho', 'Status', 'Preço', 'Forma-de-pagamento', 'cenario_teste',
  ]);

  assert.deepEqual(mapping, {
    full_name: 'NOME', cpf: 'CPF', email: 'E-mail', phone: 'WhatsApp',
    birth_date: 'Data de nascimento', gender: 'Sexo', city: 'Cidade', event_name: 'Evento',
    event_year: 'Ano do evento', category: 'Categoria do ingresso', batch: 'Lote',
    shirt_type: 'Tipo de camiseta', shirt_size: 'Tamanho', status: 'Status', amount: 'Preço',
    payment_method: 'Forma-de-pagamento',
  });
});

test('mapeamento ambiguo exige escolha manual', () => {
  const mapping = inferColumnMapping(['Nome', 'Nome completo', 'CPF']);
  assert.equal(mapping.full_name, undefined);
  assert.equal(mapping.cpf, 'CPF');
});

test('parser usa a primeira linha real e ignora colunas vazias', () => {
  const parsed = parseSpreadsheetMatrix([
    ['', '', '', ''],
    ['Nome completo', 'CPF', '__EMPTY', ''],
    ['Ana', '52998224725', 'ignorar', ''],
  ]);

  assert.deepEqual(parsed.headers, ['Nome completo', 'CPF']);
  assert.deepEqual(parsed.rows, [{ 'Nome completo': 'Ana', CPF: '52998224725' }]);
});

test('CPF valida digitos verificadores e rejeita sequencias', () => {
  assert.equal(isValidCpf('529.982.247-25'), true);
  assert.equal(isValidCpf('529.982.247-24'), false);
  assert.equal(isValidCpf('000.000.000-00'), false);
  assert.equal(isValidCpf('11111111111'), false);
});

test('idade e calculada na data do evento', () => {
  assert.equal(calculateAgeAtDate('2008-08-10', '2026-08-09T09:00:00Z'), 17);
  assert.equal(calculateAgeAtDate('2008-08-09', '2026-08-09T09:00:00Z'), 18);
  assert.equal(calculateAgeAtDate('2027-01-01', '2026-08-09T09:00:00Z'), null);
});

test('categoria e lote inexistentes nunca caem em outro registro', () => {
  const options = [{ id: '1', name: 'Primeiro lote' }, { id: '2', name: 'Segundo lote' }];
  assert.equal(resolveImportOption('Lote inexistente', options).option, null);
  assert.equal(resolveImportOption('', options).option, null);
  assert.equal(resolveImportOption('Segundo lote', options).option?.id, '2');
  assert.equal(resolveImportOption('', [{ id: '1', name: 'Unico lote' }]).option?.id, '1');
});

test('e-mail e telefone iguais nao identificam pessoas diferentes', () => {
  const candidates = [{ id: 'a', fullName: 'Ana', cpf: '52998224725', email: 'comprador@teste.com', phone: '11999999999' }];
  const match = matchCurrentImportIdentity({ cpf: '16899535009', fullName: 'Bruna', email: 'comprador@teste.com', phone: '11999999999' }, candidates);
  assert.equal(match.kind, 'new');
  assert.equal(match.participantId, null);
});

test('CPF existente e reutilizado e nome isolado exige revisao', () => {
  const candidates = [{ id: 'existing', fullName: 'Ana Silva', cpf: '52998224725' }];
  assert.equal(matchCurrentImportIdentity({ cpf: '52998224725', fullName: 'Ana S.' }, candidates).kind, 'cpf');
  assert.equal(matchCurrentImportIdentity({ cpf: null, fullName: 'Ana Silva' }, candidates).kind, 'name_review');
});

test('pendencia exclusiva de kit nao bloqueia ingresso', () => {
  assert.equal(hasTicketBlockingIssues([{ field_code: 'shirt_selection', issue_type: 'missing_required_for_inventory', message: 'pendente', blocks_payment: false, blocks_ticket_issuance: false, blocks_checkin: false, blocks_kit_delivery: true }]), false);
  assert.equal(hasTicketBlockingIssues([{ field_code: 'cpf', issue_type: 'invalid_identity', message: 'invalido', blocks_payment: false, blocks_ticket_issuance: true, blocks_checkin: false, blocks_kit_delivery: false }]), true);
});

test('contratos estaticos preservam comprador, titular e idempotencia', async () => {
  const migration = await readFile(new URL('../supabase/migrations/094_safe_current_event_import_phase1.sql', import.meta.url), 'utf8');
  const preflight = await readFile(new URL('../supabase/plans/094_safe_current_event_import_phase1_preflight.sql', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../src/app/importacoes/actions.ts', import.meta.url), 'utf8');
  assert.match(migration, /values\(v_event\.id,null,trim\(p_full_name\)/);
  assert.match(migration, /matched_user_id=null/);
  assert.match(migration, /buyer_type='imported_holder'/);
  assert.match(migration, /where order_item_id=v_item\.id/);
  assert.doesNotMatch(migration, /update public\.tickets set[^;]*ownership_status/);
  assert.doesNotMatch(migration, /participants[^\n]*(amount|payment_method|payment_status)/);
  assert.doesNotMatch(preflight, /\('tickets','ownership_status'/);
  assert.match(preflight, /\('order_items','event_id','uuid'\),\('order_items','ownership_status','text'\)/);
  assert.doesNotMatch(actions, /@importacao\.local|IMPORT\$\{|Sem camiseta|N\/A/);
  assert.doesNotMatch(actions, /update\(\{ user_id: accountUserId \}\)/);
});

test('pos-importacao encaminha pendencias pelo lote sem alterar identidade', async () => {
  const actions = await readFile(new URL('../src/app/importacoes/actions.ts', import.meta.url), 'utf8');
  const client = await readFile(new URL('../src/app/importacoes/ImportacoesClient.tsx', import.meta.url), 'utf8');
  const cadastroActions = await readFile(new URL('../src/app/cadastros/[id]/editar/actions.ts', import.meta.url), 'utf8');
  assert.match(actions, /participant_data_issues[\s\S]*import_batch_id[\s\S]*status/);
  assert.match(client, /Resolver pendências/);
  assert.match(client, /import_batch_id=/);
  assert.match(cadastroActions, /from\("registration_contacts"\)/);
  assert.doesNotMatch(cadastroActions, /reevaluate_participant_data_issues|finalize_imported_participant_after_issue_resolution/);
  assert.doesNotMatch(cadastroActions, /from\("(orders|order_items|tickets|payments)"\)\.update/);
});

test('resolvedor compartilhado usa controles fechados e valida dados pessoais', async () => {
  const dialog = await readFile(new URL('../src/app/inscricoes/participant-issues-dialog.tsx', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../src/app/inscricoes/actions.ts', import.meta.url), 'utf8');
  const cadastroList = await readFile(new URL('../src/app/cadastros/cadastro-list.tsx', import.meta.url), 'utf8');
  assert.match(dialog, /BirthDateInput/);
  assert.match(dialog, /isValidCpf/);
  assert.match(dialog, /formatPhone/);
  assert.match(dialog, /Categoria do ingresso/);
  assert.match(dialog, /<span>Lote<\/span><select/);
  assert.match(dialog, /deduplicateIssues/);
  assert.match(actions, /resolve_ticket_data_issues/);
  assert.match(actions, /finalize_imported_ticket_after_issue_resolution/);
  assert.match(actions, /ticket_categories[\s\S]*registration_batches/);
  assert.match(cadastroList, /Abrir ficha/);
  assert.doesNotMatch(cadastroList, /overflow-x-auto|min-w-\[/);
});

test('defaults de categoria e lote resolvem 300 linhas sem sobrescrever valor explícito válido', () => {
  const categories = [{ id: 'open', name: 'Open Bar' }, { id: 'vip', name: 'VIP' }];
  const rows = Array.from({ length: 300 }, (_, index) => index === 0 ? 'VIP' : index === 1 ? 'Categoria desconhecida' : '');
  const resolved = rows.map((value) => resolveImportOptionWithDefault(value, categories, 'open'));
  assert.equal(resolved[0].option?.id, 'vip');
  assert.equal(resolved[0].source, 'explicit');
  assert.equal(resolved[1].option?.id, 'open');
  assert.equal(resolved[1].source, 'default');
  assert.equal(resolved.filter((item) => item.option?.id === 'open').length, 299);
  assert.equal(resolveImportOptionWithDefault('VIP', categories, 'open').option?.id, 'vip');
});

test('resolução em massa confirma quantidade e reutiliza reavaliação/finalização da 094', async () => {
  const component = await readFile(new URL('../src/app/cadastros/bulk-import-issues.tsx', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
  assert.match(component, /Aplicar .* a \$\{selected\.size\} cadastros/);
  assert.match(component, /Escolher registros individualmente/);
  assert.match(actions, /resolve_import_ticket_options/);
  assert.match(actions, /finalize_imported_ticket_after_issue_resolution/);
  assert.doesNotMatch(actions, /insert\([^)]*(orders|order_items|tickets|payments)/);
});

test('cadastros separa visão geral do filtro explícito por lote', async () => {
  const page = await readFile(new URL('../src/app/cadastros/page.tsx', import.meta.url), 'utf8');
  const sidebar = await readFile(new URL('../src/components/dashboard/Sidebar.tsx', import.meta.url), 'utf8');
  // EVENT_SCOPED_HREFS foi extraida pra src/lib/navigation/admin-menu.ts
  // (compartilhada com a navegacao mobile); Sidebar.tsx so chama a funcao
  // eventScopedHref(href, selectedEventId), que consulta essa lista.
  const adminMenu = await readFile(new URL('../src/lib/navigation/admin-menu.ts', import.meta.url), 'utf8');
  const importer = await readFile(new URL('../src/app/importacoes/ImportacoesClient.tsx', import.meta.url), 'utf8');
  assert.match(page, /import_batch_id/);
  assert.match(page, /Ver todos os cadastros/);
  assert.match(page, /href="\/cadastros"/);
  assert.match(importer, /import_batch_id=/);
  assert.match(sidebar, /const href = eventScopedHref\(item\.href, selectedEventId\)/);
  assert.match(sidebar, /router\.push\(href\)/);
  assert.match(sidebar, /EVENT_SCOPED_HREFS\.includes\(href\)/);
  assert.match(adminMenu, /=\s*\[\s*\n\s*"\/operacoes",[\s\S]*"\/painel",[\s\S]*"\/cadastros",[\s\S]*"\/financeiro",[\s\S]*"\/cupons",\s*\n\s*\];/);
  assert.doesNotMatch(page, /type Params[^\n]*importBatchId/);
});

test('convite 096 usa auth.users como fonte canônica de e-mail', async () => {
  const migration = await readFile(new URL('../supabase/migrations/096_participant_self_service_issues.sql', import.meta.url), 'utf8');
  const preflight = await readFile(new URL('../supabase/plans/096_participant_self_service_issues_preflight.sql', import.meta.url), 'utf8');
  const firstAccess = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
  assert.match(migration, /from auth\.users au[\s\S]*au\.email/);
  assert.match(migration, /from auth\.users where id=v_actor/);
  assert.doesNotMatch(migration, /customer_profiles[^\n]*(email)|cp\.email/);
  assert.match(preflight, /table_schema='auth'[\s\S]*column_name='email'/);
  assert.match(preflight, /join auth\.users au/);
  assert.doesNotMatch(preflight, /cp\.email|customer_profiles[^\n]*column_name='email'/);
  assert.doesNotMatch(firstAccess, /customer_profiles[^\n]*email|cp\.email/);
  assert.doesNotMatch(migration, /link_participation_history_by_cpf/);
  assert.doesNotMatch(preflight, /link_participation_history_by_cpf|has_legacy_link/);
  assert.doesNotMatch(firstAccess, /link_participation_history_by_cpf/);
  assert.match(migration, /update public\.participants set user_id=v_actor/);
  assert.match(migration, /update public\.participation_history set user_id=v_actor[\s\S]*where participant_id=v_p\.id/);
});

test('convites em massa reutilizam a elegibilidade canônica e isolam falhas', async () => {
  const migration096 = await readFile(new URL('../supabase/migrations/096_participant_self_service_issues.sql', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../supabase/migrations/097_bulk_first_access_invite_eligibility.sql', import.meta.url), 'utf8');
  const preflight = await readFile(new URL('../supabase/plans/097_bulk_first_access_invite_eligibility_preflight.sql', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../src/app/cadastros/bulk-first-access-invites.tsx', import.meta.url), 'utf8');
  assert.match(migration, /check_participant_account_invite_eligibility/);
  assert.match(migration, /select \* into v_check from public\.check_participant_account_invite_eligibility/);
  assert.match(actions, /for \(const participantId of ids\)/);
  assert.match(actions, /prepare_participant_account_invite/);
  assert.match(actions, /prepared_not_sent/);
  assert.match(panel, /Selecionar todos os resultados/);
  assert.match(panel, /de \{preview\.total\} cadastros estão aptos/);
  assert.match(panel, /Envio aceito pelo provedor/);
  assert.doesNotMatch(actions, /update\([^\n]*user_id/);
  assert.doesNotMatch(migration096, /check_participant_account_invite_eligibility/);
  assert.doesNotMatch(migration, /create table|alter table|create unique index/i);
  assert.match(preflight, /safe_to_apply/);
  assert.match(preflight, /migration_096_recorded/);
});

test('migration 098 qualifica e-mail e demais colunas na elegibilidade', async () => {
  const migration = await readFile(new URL('../supabase/migrations/098_fix_invite_eligibility_ambiguous_email.sql', import.meta.url), 'utf8');
  const preflight = await readFile(new URL('../supabase/plans/098_fix_invite_eligibility_ambiguous_email_preflight.sql', import.meta.url), 'utf8');
  assert.match(migration, /from public\.participants p[\s\S]*p\.organization_id[\s\S]*p\.user_id[\s\S]*p\.email/);
  assert.match(migration, /auth\.users au[\s\S]*au\.email/);
  assert.doesNotMatch(migration, /coalesce\(email,/);
  assert.doesNotMatch(migration, /create table|alter table|create index/i);
  assert.match(preflight, /safe_to_apply/);
  assert.match(preflight, /has_unqualified_email_reference/);
});

test('migration 099 permite reenvio somente com correlacao explicita ao mesmo auth user', async () => {
  const migration = await readFile(new URL('../supabase/migrations/099_reinvite_existing_participant_auth_user.sql', import.meta.url), 'utf8');
  const preflight = await readFile(new URL('../supabase/plans/099_reinvite_existing_participant_auth_user_preflight.sql', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
  assert.match(migration, /add column if not exists auth_user_id uuid references auth\.users\(id\)/);
  assert.match(migration, /raw_user_meta_data->>'participant_invite_id'=pai\.id::text/);
  assert.match(migration, /pai\.auth_user_id=v_auth_user\.id/);
  assert.match(migration, /account_conflict/);
  assert.match(migration, /resend_invite_password_required/);
  assert.match(migration, /resend_invite_existing_account/);
  assert.match(actions, /shouldCreateUser: false/);
  assert.match(actions, /participant_account_invites/);
  assert.doesNotMatch(actions, /from\("participants"\)\.update\(\{[^\n]*user_id/);
  assert.match(preflight, /safe_to_apply/);
  assert.match(preflight, /ambiguous_legacy_correlations/);
});

test('migration 100 reconcilia histories confirmados antes de reivindicar convite', async () => {
  const migration = await readFile(new URL('../supabase/migrations/100_reconcile_participation_history_on_invite_claim.sql', import.meta.url), 'utf8');
  assert.match(migration, /create or replace function public\.claim_participant_account_invite/);
  assert.match(migration, /v_inv\.auth_user_id is distinct from v_actor/);
  assert.match(migration, /ph\.participant_id=v_p\.id[\s\S]*ph\.user_id<>v_actor/);
  assert.match(migration, /set status='duplicate'[\s\S]*ph\.id<>v_canonical_history_id/);
  assert.ok(
    migration.indexOf("set status='duplicate'") < migration.indexOf('set user_id=v_actor'),
    'duplicados confirmados devem ser reconciliados antes de receber o user_id',
  );
  assert.match(migration, /if v_inv\.status='claimed'[\s\S]*return v_p\.id/);
  assert.match(migration, /canonical_history_id/);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.participation_history/i);
  assert.doesNotMatch(migration, /drop\s+index/i);
  assert.doesNotMatch(migration, /normalize_(email|cpf)|lower\s*\(\s*ph\.email|ph\.cpf/i);
});

test('preflight 100 e somente leitura e cobre seguranca estrutural e de identidade', async () => {
  const preflight = await readFile(new URL('../supabase/plans/100_reconcile_participation_history_on_invite_claim_preflight.sql', import.meta.url), 'utf8');
  const executableSql = preflight.replace(/--.*$/gm, '');
  assert.doesNotMatch(executableSql, /\b(insert|update|delete|merge|alter|create|drop|truncate|grant|revoke|call|do)\b/i);
  assert.match(preflight, /to_regclass\('public\.ux_participation_history_user_event_confirmed'\)/);
  assert.match(preflight, /information_schema\.columns[\s\S]*column_name='auth_user_id'/);
  assert.match(preflight, /actor_user_id is null or not f\.actor_user_exists/);
  assert.match(preflight, /participant_event_id is distinct from f\.invite_event_id/);
  assert.match(preflight, /other_user_history_count>0/);
  assert.match(preflight, /actor_confirmed_participant_id<>f\.participant_id/);
  assert.match(preflight, /confirmed_history_count/);
  assert.match(preflight, /array_agg\(h\.id order by h\.created_at,h\.id\)/);
  assert.match(preflight, /canonical_history_id/);
  assert.match(preflight, /histories_to_mark_duplicate/);
  assert.match(preflight, /safe_invite_count/);
  assert.match(preflight, /ambiguous_invite_count/);
  assert.match(preflight, /blocked_invite_count/);
  assert.match(preflight, /safe_to_apply/);
  assert.doesNotMatch(executableSql, /\b(email|cpf|full_name|normalized_name)\b/i);
});

test('diagnostico 101 prova se duplicate entra no calculo ativo de lote', async () => {
  const diagnostic = await readFile(new URL('../supabase/plans/101_finalize_imported_participant_history_status_diagnostic.sql', import.meta.url), 'utf8');
  const executableSql = diagnostic.replace(/--.*$/gm, '');
  assert.doesNotMatch(executableSql, /\b(insert|update|delete|merge|alter|create|drop|truncate|grant|revoke|call|do)\b/i);
  assert.match(diagnostic, /pg_get_functiondef\(p\.oid\)/);
  assert.match(diagnostic, /active_participation_history_function_audit/);
  assert.match(diagnostic, /batches_including_all_import_statuses/);
  assert.match(diagnostic, /batches_from_confirmed_only/);
  assert.match(diagnostic, /batches_from_duplicate_only/);
  assert.match(diagnostic, /filters_confirmed_status/);
  assert.match(diagnostic, /explicitly_excludes_duplicate_status/);
  assert.match(diagnostic, /error_caused_by_duplicate_status_in_batch_count/);
});

test('migration 101 altera somente a evidencia confirmed da finalizacao ativa', async () => {
  const migration = await readFile(new URL('../supabase/migrations/101_filter_confirmed_history_in_import_finalization.sql', import.meta.url), 'utf8');
  assert.match(migration, /pg_get_functiondef\(v_signature\)/);
  assert.match(migration, /v_definition:=replace\(v_definition,v_expected,v_replacement\)/);
  assert.match(migration, /ph\.source='import' and ph\.status='confirmed'/);
  assert.match(migration, /v_actorisdistinctfromv_participant\.user_idandnotpublic\.user_can_access_organization/);
  assert.match(migration, /Reaplicacao segura/);
  assert.match(migration, /execute v_definition/);
  assert.match(migration, /revoke all on function public\.finalize_imported_participant_after_issue_resolution/);
  assert.match(migration, /grant execute on function public\.finalize_imported_participant_after_issue_resolution/);
  assert.doesNotMatch(migration, /create or replace function public\.finalize_imported_participant_after_issue_resolution/);
  assert.doesNotMatch(migration, /\b(delete|truncate|drop)\b/i);
});

test('preflight 101 valida assinatura, predicado exato e impacto antes da aplicacao', async () => {
  const preflight = await readFile(new URL('../supabase/plans/101_filter_confirmed_history_in_import_finalization_preflight.sql', import.meta.url), 'utf8');
  const executableSql = preflight.replace(/--.*$/gm, '');
  assert.doesNotMatch(executableSql, /\b(insert|update|delete|merge|alter|create|drop|truncate|grant|revoke|call|do)\b/i);
  assert.match(preflight, /has_expected_function_signature/);
  assert.match(preflight, /has_owner_authorization_from_096/);
  assert.match(preflight, /confirmed_filter_already_installed/);
  assert.match(preflight, /exact_source_predicate_is_replaceable/);
  assert.match(preflight, /where ph\.participant_id=p_participant_id and ph\.source='import';/);
  assert.match(preflight, /affected_participant_count/);
  assert.match(preflight, /participants_with_multiple_confirmed_batches/);
  assert.match(preflight, /participants_without_confirmed_batch/);
  assert.match(preflight, /participants_with_duplicate_only_extra_batches/);
  assert.match(preflight, /structurally_ambiguous_participant_count/);
  assert.match(preflight, /affected_participants_with_multiple_confirmed_batches/);
  assert.match(preflight, /affected_participants_without_confirmed_batch/);
  assert.match(preflight, /affected_structurally_ambiguous_participant_count/);
  assert.match(preflight, /preserves_preexisting_confirmed_ambiguity/);
  assert.match(preflight, /affected_participants_without_confirmed_batch=0/);
  assert.match(preflight, /affected_structurally_ambiguous_participant_count=0/);
  assert.doesNotMatch(preflight, /and i\.participants_with_multiple_confirmed_batches=0/);
  assert.match(preflight, /safe_to_apply/);
});

test('primeiro acesso carrega e resolve somente o participant indicado pelo convite', async () => {
  const inviteContext = await readFile(new URL('../src/lib/account/participant-invite.ts', import.meta.url), 'utf8');
  const invitePolicy = await readFile(new URL('../src/lib/account/participant-invite-policy.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../src/app/primeiro-acesso/page.tsx', import.meta.url), 'utf8');
  const action = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
  const form = await readFile(new URL('../src/app/primeiro-acesso/FirstAccessForm.tsx', import.meta.url), 'utf8');
  assert.match(inviteContext, /eq\('id', inviteId\)/);
  assert.match(inviteContext, /eq\('id', invite\.participant_id\)/);
  assert.match(inviteContext, /evaluateParticipantInviteAccess/);
  assert.match(invitePolicy, /input\.authUserId === input\.userId/);
  assert.match(invitePolicy, /input\.metadataInviteId === input\.inviteId/);
  assert.doesNotMatch(inviteContext, /participants[^\n]*eq\('email'/);
  assert.match(page, /preferParticipant\('full_name'\)/);
  assert.match(page, /preferParticipant\('birth_date'\)/);
  assert.match(form, /Dado já informado/);
  assert.match(form, /Preenchimento necessário/);
  assert.match(action, /claim_participant_account_invite/);
  assert.match(action, /resolve_ticket_data_issues/);
  assert.match(action, /select\('order_item_id'\)/);
  assert.match(action, /inviteContext\.openIssueIds/);
  assert.doesNotMatch(action, /issueValues\.(category|batch)/);
});

test('primeiro acesso A — admin sem onboarding proprio permanece no painel', async () => {
  const page = await readFile(new URL('../src/app/primeiro-acesso/page.tsx', import.meta.url), 'utf8');
  const accountLayout = await readFile(new URL('../src/app/minha-conta/layout.tsx', import.meta.url), 'utf8');
  assert.match(page, /canAccessAdministrativePanel\(\)[\s\S]*redirect\('\/painel'\)/);
  assert.match(accountLayout, /flags\.firstAccessRequired && !isAdministrativeUser/);
});

test('primeiro acesso B — convite carrega os dados do participant explicito', async () => {
  const context = await readFile(new URL('../src/lib/account/participant-invite.ts', import.meta.url), 'utf8');
  const page = await readFile(new URL('../src/app/primeiro-acesso/page.tsx', import.meta.url), 'utf8');
  assert.match(context, /invite\.participant_id/);
  for (const field of ['full_name', 'cpf', 'birth_date', 'gender', 'phone', 'email', 'city']) assert.match(page, new RegExp(`preferParticipant\\('${field}'\\)`));
});

test('primeiro acesso C — somente nascimento pendente permanece editavel', async () => {
  const page = await readFile(new URL('../src/app/primeiro-acesso/page.tsx', import.meta.url), 'utf8');
  const form = await readFile(new URL('../src/app/primeiro-acesso/FirstAccessForm.tsx', import.meta.url), 'utf8');
  assert.match(page, /editableFields\.add\('birth_date'\)/);
  assert.match(form, /disabled=\{!editable\.has\('birth_date'\)\}/);
  assert.match(form, /readOnly=\{!editable\.has\('cpf'\)\}/);
  assert.match(form, /Dado já informado/);
});

test('primeiro acesso D — pendencia admin permanece em conferencia', async () => {
  const pendingPage = await readFile(new URL('../src/app/primeiro-acesso/pendencias/page.tsx', import.meta.url), 'utf8');
  const action = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
  assert.match(pendingPage, /Cadastro enviado para conferência do organizador/);
  assert.match(pendingPage, /resolution_scope !== "user_resolvable"/);
  assert.match(action, /\.in\('participant_id', linkedParticipantIds\)\.eq\('status', 'open'\)/);
});

test('primeiro acesso E — finaliza de forma idempotente e segue para ingressos', async () => {
  const action = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
  const cadastroActions = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
  assert.match(action, /claim_participant_account_invite[\s\S]*finalize_imported_ticket_after_issue_resolution/);
  assert.match(cadastroActions, /\/minha-conta\/ingressos/);
  assert.doesNotMatch(action, /from\('(orders|payments|order_items|tickets)'\)\.(insert|update)/);
});

test('primeiro acesso F — sessao alheia nao acessa nem resolve outro participant', async () => {
  const context = await readFile(new URL('../src/lib/account/participant-invite.ts', import.meta.url), 'utf8');
  const policy = await readFile(new URL('../src/lib/account/participant-invite-policy.ts', import.meta.url), 'utf8');
  const action = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
  assert.match(context, /evaluateParticipantInviteAccess/);
  assert.match(policy, /input\.claimedUserId !== input\.userId \|\| input\.authUserId !== input\.userId/);
  assert.match(policy, /input\.metadataInviteId === input\.inviteId/);
  assert.match(action, /getParticipantInviteContext\(inviteId, user\)/);
  assert.doesNotMatch(context, /from\('participants'\)[^\n]*eq\('email'/);
});

const invitePolicyBase = {
  inviteId: 'invite-1',
  inviteStatus: 'pending',
  expiresAt: '2030-01-01T00:00:00.000Z',
  inviteEmail: 'user@example.com',
  authUserId: 'user-1',
  claimedUserId: null,
  participantUserId: null,
  userId: 'user-1',
  userEmail: 'user@example.com',
  metadataInviteId: 'invite-1',
  nowMs: Date.parse('2029-01-01T00:00:00.000Z'),
};

test('contrato de convite — pending valido', () => {
  assert.equal(evaluateParticipantInviteAccess(invitePolicyBase), null);
  assert.equal(evaluateParticipantInviteAccess({ ...invitePolicyBase, authUserId: null }), null);
});

test('contrato de convite — pending expirado', () => {
  assert.equal(evaluateParticipantInviteAccess({
    ...invitePolicyBase,
    expiresAt: '2028-01-01T00:00:00.000Z',
  }), 'inactive');
});

test('contrato de convite — claimed pelo mesmo usuario', () => {
  assert.equal(evaluateParticipantInviteAccess({
    ...invitePolicyBase,
    inviteStatus: 'claimed',
    claimedUserId: 'user-1',
    participantUserId: 'user-1',
  }), null);
});

test('contrato de convite — claimed por outro usuario', () => {
  assert.equal(evaluateParticipantInviteAccess({
    ...invitePolicyBase,
    inviteStatus: 'claimed',
    authUserId: 'user-2',
    claimedUserId: 'user-2',
    participantUserId: 'user-2',
  }), 'wrong_session');
});

test('contrato de convite — participant vinculado a outro usuario', () => {
  assert.equal(evaluateParticipantInviteAccess({
    ...invitePolicyBase,
    participantUserId: 'user-2',
  }), 'participant_conflict');
});

test('contrato de convite — retry apos claim ignora expiracao e dados pending', () => {
  assert.equal(evaluateParticipantInviteAccess({
    ...invitePolicyBase,
    inviteStatus: 'claimed',
    expiresAt: '2020-01-01T00:00:00.000Z',
    inviteEmail: 'old@example.com',
    userEmail: 'new@example.com',
    metadataInviteId: null,
    claimedUserId: 'user-1',
    participantUserId: 'user-1',
  }), null);
});

test('portal — participante com seis pendencias administrativas acessa minha conta', async () => {
  const layout = await readFile(new URL('../src/app/minha-conta/layout.tsx', import.meta.url), 'utf8');
  const issues = Array.from({ length: 6 }, () => ({ resolution_scope: 'admin_only' }));
  assert.equal(issues.filter(isAdministrativeIssue).length, 6);
  assert.equal(issues.filter(isRequiredUserResolvableIssue).length, 0);
  assert.match(layout, /Cadastro em análise/);
  assert.doesNotMatch(layout, /requiredIssueCount[\s\S]*redirect\('\/primeiro-acesso\/pendencias'\)/);
});

test('portal — ingressos em conferencia nao exibem QR Code', async () => {
  const list = await readFile(new URL('../src/app/minha-conta/ingressos/page.tsx', import.meta.url), 'utf8');
  const detail = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
  const card = await readFile(new URL('../src/components/militrin/MilitrinTicketCard.tsx', import.meta.url), 'utf8');
  assert.match(list, /blocks_ticket_issuance/);
  assert.match(list, /Ingresso aguardando conferência/);
  assert.match(list, /qrUrl=\{item\.canShowTicket \? item\.qrUrl : null\}/);
  assert.match(detail, /ticketIssuanceBlocked[\s\S]*Ingresso aguardando conferência/);
  assert.match(card, /qrUrl \?/);
});

test('portal — pendencia obrigatoria corrigivel continua indo para pendencias', async () => {
  const action = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
  assert.equal(isRequiredUserResolvableIssue({ resolution_scope: 'user_resolvable', field_code: 'birth_date' }), true);
  assert.equal(isRequiredUserResolvableIssue({ resolution_scope: 'admin_only', field_code: 'birth_date' }), false);
  assert.match(action, /resolution_scope', 'user_resolvable'/);
  assert.match(action, /REQUIRED_PARTICIPANT_FIELD_CODES/);
});

test('portal — conta explicitamente blocked continua em acesso negado', async () => {
  const layout = await readFile(new URL('../src/app/minha-conta/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /flags\.isBlocked[\s\S]*redirect\('\/acesso-negado'\)/);
});

test('portal — participante sem permissao administrativa nao acessa painel', async () => {
  const painel = await readFile(new URL('../src/app/painel/layout.tsx', import.meta.url), 'utf8');
  const denied = await readFile(new URL('../src/app/acesso-negado/page.tsx', import.meta.url), 'utf8');
  const login = await readFile(new URL('../src/app/entrar/page.tsx', import.meta.url), 'utf8');
  assert.match(painel, /requireAdministrativePanelAccess\(\)/);
  assert.match(denied, /href="\/minha-conta"[\s\S]*Ir para minha conta/);
  assert.match(login, /defaultNext="\/minha-conta"/);
  assert.doesNotMatch(login, /defaultNext="\/painel"/);
});

test('portal — politica canonica controla botao e guard administrativo', async () => {
  const policy = await readFile(new URL('../src/lib/admin/panel-access.ts', import.meta.url), 'utf8');
  const layout = await readFile(new URL('../src/app/minha-conta/layout.tsx', import.meta.url), 'utf8');
  const navigation = await readFile(new URL('../src/app/minha-conta/account-nav.tsx', import.meta.url), 'utf8');
  const painel = await readFile(new URL('../src/app/painel/layout.tsx', import.meta.url), 'utf8');

  assert.match(policy, /export async function canAccessAdministrativePanel/);
  assert.match(policy, /'dashboard\.view'/);
  assert.match(policy, /'checkin\.view'/);
  assert.match(policy, /'kits\.view'/);
  assert.match(layout, /canAccessAdministrativePanel\(\)/);
  assert.match(layout, /AccountSidebarNav isAdministrativeUser=\{isAdministrativeUser\}/);
  assert.match(navigation, /isAdministrativeUser \? \([\s\S]*Painel administrativo/);
  assert.match(painel, /requireAdministrativePanelAccess\(\)/);
  assert.match(policy, /requireAdministrativePanelAccess[\s\S]*canAccessAdministrativePanel\(\)/);
});

test('portal — participante comum nao recebe acesso operacional por identidade', async () => {
  const policy = await readFile(new URL('../src/lib/admin/panel-access.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(policy, /email|metadata|cargo|role_name|full_name/i);
  assert.match(policy, /results\.some\(Boolean\)/);
});

test('portal — botao administrativo existe no desktop (sidebar), no Menu mobile e como atalho no Perfil, e leva ao painel', async () => {
  // AJUSTE MOBILE (bottom nav do usuario = Início/Eventos/Loja/Carrinho/
  // Menu): "Painel administrativo" nao e mais item principal da bottom nav
  // em NENHUMA das 2 versoes -- desktop e mobile leem o MESMO booleano
  // (isAdministrativeUser) atraves do MESMO componente compartilhado
  // (AdminAndSponsorShortcuts), nunca uma segunda logica de permissao. No
  // mobile, o atalho fica acessivel pelo "Menu" (MenuSheet) da bottom nav;
  // o atalho historico dentro do Perfil continua existindo tambem, nunca
  // removido.
  const navigation = await readFile(new URL('../src/app/minha-conta/account-nav.tsx', import.meta.url), 'utf8');
  const perfilPage = await readFile(new URL('../src/app/minha-conta/dados/page.tsx', import.meta.url), 'utf8');
  assert.match(navigation, /Painel administrativo/);
  assert.match(navigation, /function AdminAndSponsorShortcuts\(/);
  assert.match(navigation, /href="\/painel"/);
  assert.match(navigation, /export function AccountSidebarNav[\s\S]*<AdminAndSponsorShortcuts/);
  assert.match(navigation, /function MenuSheet\([\s\S]*<AdminAndSponsorShortcuts/);
  assert.match(perfilPage, /canAccessAdministrativePanel/);
  assert.match(perfilPage, /href="\/painel"[\s\S]*Painel administrativo/);
});

test('portal — destino pos-login operacional usa a mesma politica', async () => {
  const action = await readFile(new URL('../src/app/inscricao/actions.ts', import.meta.url), 'utf8');
  assert.match(action, /canAccessAdministrativePanel\(params\.userId\)/);
  assert.match(action, /fallback: administrativeAccess \? '\/painel' : '\/minha-conta'/);
});

test('portal — marca e saudacao da Minha conta usam Militrin', async () => {
  const files = [
    '../src/app/minha-conta/layout.tsx',
    '../src/app/minha-conta/page.tsx',
    '../src/app/minha-conta/dados/page.tsx',
    '../src/app/minha-conta/nivel/page.tsx',
  ];
  const contents = await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), 'utf8')));
  assert.doesNotMatch(contents.join('\n'), /NEXORA/);
  assert.match(contents[1], /title=\{`Olá, \$\{greetingName\}!`\}/);
  assert.match(contents[1], /Bem-vindo à sua conta Militrin\./);
});

test('portal — pendencias administrativas nao alteram account_status', async () => {
  const layout = await readFile(new URL('../src/app/minha-conta/layout.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(layout, /customer_profiles[^\n]*update|account_status\s*:/);
});

test('portal — cada flag bloqueia somente sua operacao', () => {
  const keys = ['blocks_payment', 'blocks_ticket_issuance', 'blocks_checkin', 'blocks_kit_delivery'];
  const expected = ['payment', 'ticketIssuance', 'checkin', 'kitDelivery'];
  keys.forEach((key, index) => {
    const blocks = getParticipantOperationBlocks([{ [key]: true }]);
    for (const operation of expected) assert.equal(blocks[operation], operation === expected[index]);
  });
});

test('callback de convite sempre termina com sessao, erro ou timeout visivel', async () => {
  const callback = await readFile(new URL('../src/app/auth/callback/AuthCallbackClient.tsx', import.meta.url), 'utf8');
  assert.match(callback, /CALLBACK_TIMEOUT_MS = 10_000/);
  assert.match(callback, /isSingleton: false/);
  assert.match(callback, /detectSessionInUrl: false/);
  assert.match(callback, /exchangeCodeForSession\(code\)/);
  assert.match(callback, /verifyOtp\(\{ token_hash: tokenHash/);
  assert.match(callback, /setSession\(\{ access_token: accessToken, refresh_token: refreshToken \}\)/);
  assert.match(callback, /auth\.getSession\(\)/);
  assert.match(callback, /\.catch\(\(error: unknown\)/);
  assert.match(callback, /\.finally\(\(\) =>/);
  assert.match(callback, /startedRef\.current/);
  assert.match(callback, /window\.history\.replaceState/);
  assert.ok(
    callback.indexOf("window.history.replaceState") < callback.indexOf("exchangeCodeForSession(code)"),
    'credenciais devem sair da URL antes da primeira chamada de autenticação',
  );
  assert.match(callback, /router\.replace\(destination\)/);
  assert.match(callback, /Solicitar novo convite/);
  assert.doesNotMatch(callback, /console\.(info|error)\([^\n]*(code|tokenHash|accessToken|refreshToken)\b/);
  assert.doesNotMatch(callback, /router\.(push|replace)\(['"]\/entrar/);
});

test('migration 102 persiste exigencia de senha somente para convite importado', async () => {
  const migration = await readFile(new URL('../supabase/migrations/102_persist_imported_participant_invite_password_setup.sql', import.meta.url), 'utf8');
  assert.match(migration, /requires_password_setup boolean not null default false/);
  assert.match(migration, /password_setup_completed_at timestamptz/);
  assert.match(migration, /ph\.source='import'/);
  assert.match(migration, /password_setup_completed_at=null/);
  assert.doesNotMatch(migration, /must_change_password|coalesce\(pai\.claimed_at/);
  assert.match(migration, /v_expected[\s\S]*v_auth_user\.encrypted_password/);
  assert.match(migration, /v_replacement[\s\S]*ph\.source='import'/);
  assert.match(migration, /replace\(v_definition,v_expected,v_replacement\)/);
  assert.match(migration, /position\('encrypted_password' in v_definition\)>0[\s\S]*raise exception/);
  assert.match(migration, /Definicao ativa diverge das garantias esperadas da migration 099/);
  assert.match(migration, /revoke all on function public\.check_participant_account_invite_eligibility/);
  assert.match(migration, /pai\.status='claimed' or \(pai\.status='pending' and pai\.expires_at>now\(\)\)/);
  assert.match(migration, /and pai\.password_setup_completed_at is null/);
  assert.doesNotMatch(migration, /pai\.status in\('revoked','expired'\)/);
  assert.match(migration, /requires_password_setup=public\.participant_account_invites\.requires_password_setup[\s\S]*or excluded\.requires_password_setup/);
  assert.doesNotMatch(migration, /complete_participant_invite_password_setup/);
});

test('preflight 102 e somente leitura e verifica seguranca da aplicacao', async () => {
  const preflight = await readFile(new URL('../supabase/plans/102_persist_imported_participant_invite_password_setup_preflight.sql', import.meta.url), 'utf8');
  assert.match(preflight, /requires_password_setup_already_installed/);
  assert.match(preflight, /password_setup_completed_at_already_installed/);
  assert.match(preflight, /structurally_ambiguous_claimed_invite_count/);
  assert.match(preflight, /claimed_invites_requiring_explicit_password_setup_count/);
  assert.match(preflight, /pending_invites_requiring_password_setup_count/);
  assert.match(preflight, /existing_explicit_completion_count/);
  assert.match(preflight, /invalid_completion_state_count/);
  assert.match(preflight, /has_invalid_completion_state/);
  assert.match(preflight, /active_database_functions_read_encrypted_password/);
  assert.match(preflight, /active_legacy_password_classification_detected/);
  assert.match(preflight, /eligibility_body_matches_expected_099/);
  assert.match(preflight, /eligibility_102_classification_installed/);
  assert.match(preflight, /non_eligibility_functions_read_encrypted_password/);
  assert.match(preflight, /position\([\s\S]*'encrypted_password'[\s\S]*ad\.prepare_definition/);
  assert.doesNotMatch(preflight, /false as reads_encrypted_password|0::integer as inferred_password_completion_count/);
  assert.doesNotMatch(preflight, /auth\.users|au\.encrypted_password|claimed_retry_completion_inference_count/);
  assert.match(preflight, /safe_to_apply/);
  assert.doesNotMatch(preflight, /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b\s+(table|public\.|auth\.)/i);
});

test('primeiro acesso importado usa estado persistido e ignora set_password da URL', async () => {
  const page = await readFile(new URL('../src/app/primeiro-acesso/page.tsx', import.meta.url), 'utf8');
  const context = await readFile(new URL('../src/lib/account/participant-invite.ts', import.meta.url), 'utf8');
  const dispatch = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
  assert.match(context, /Boolean\(invite\.requires_password_setup\) && !invite\.password_setup_completed_at/);
  assert.match(page, /inviteContext \? inviteContext\.requiresPasswordSetup : status\.mustChangePassword/);
  assert.doesNotMatch(page, /set_password/);
  assert.doesNotMatch(dispatch, /set_password/);
  assert.doesNotMatch(page, /params\.set_password|searchParams[\s\S]*set_password/);
});

test('primeiro acesso valida senha no servidor e conclui estado somente apos updateUser', async () => {
  const action = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
  assert.match(action, /newPassword\.length < 8/);
  assert.match(action, /newPassword !== confirmPassword/);
  assert.match(action, /newPassword === cpf/);
  const updateIndex = action.indexOf("supabase.auth.updateUser({ password: newPassword })");
  const completionIndex = action.indexOf("password_setup_completed_at: new Date().toISOString()");
  const claimIndex = action.indexOf("claim_participant_account_invite");
  assert.ok(updateIndex >= 0 && completionIndex > updateIndex && claimIndex > completionIndex);
  assert.match(action, /passwordUpdate\.error[\s\S]*return \{ success: false[\s\S]*passwordInviteContext = await getParticipantInviteContext/);
  assert.match(action, /passwordInviteContext\.valid[\s\S]*passwordInviteContext\.requiresPasswordSetup/);
  assert.match(action, /\.eq\('auth_user_id', user\.id\)/);
  assert.match(action, /\.eq\('requires_password_setup', true\)/);
  assert.match(action, /\.is\('password_setup_completed_at', null\)/);
});

test('falha posterior ocorre depois da conclusao persistida e retry nao redefine senha', async () => {
  const action = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
  const context = await readFile(new URL('../src/lib/account/participant-invite.ts', import.meta.url), 'utf8');
  const completionIndex = action.indexOf("password_setup_completed_at: new Date().toISOString()");
  const profileIndex = action.indexOf('const profileUpdate = await upsertCustomerProfileCompat');
  const finalizationIndex = action.indexOf("finalize_imported_ticket_after_issue_resolution");
  assert.ok(completionIndex >= 0 && profileIndex > completionIndex && finalizationIndex > completionIndex);
  assert.match(context, /requiresPasswordSetup: Boolean\(invite\.requires_password_setup\) && !invite\.password_setup_completed_at/);
});

test('retry posterior nao pede senha concluida e reenvio nao cria outra conta Auth', async () => {
  const context = await readFile(new URL('../src/lib/account/participant-invite.ts', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../supabase/migrations/102_persist_imported_participant_invite_password_setup.sql', import.meta.url), 'utf8');
  const dispatch = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
  assert.match(context, /!invite\.password_setup_completed_at/);
  assert.match(migration, /on conflict\(participant_id\) where status='pending'/);
  assert.match(dispatch, /shouldCreateUser: false/);
  assert.match(dispatch, /isResend[\s\S]*signInWithOtp/);
  assert.match(dispatch, /inviteUserByEmail/);
});

test('senha de primeiro acesso nao e enviada ou registrada em logs', async () => {
  const action = await readFile(new URL('../src/app/primeiro-acesso/actions.ts', import.meta.url), 'utf8');
  const dispatch = await readFile(new URL('../src/app/cadastros/actions.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(dispatch, /new_password|confirm_password|password\s*:/i);
  assert.doesNotMatch(action, /console\.(?:log|info|warn|error)\([^\n]*(?:newPassword|confirmPassword|formData)/);
  assert.doesNotMatch(action, /Object\.fromEntries\(formData|JSON\.stringify\(formData/);
});

test('painel administrativo oferece logout compartilhado em todas as areas', async () => {
  const sidebar = await readFile(new URL('../src/components/dashboard/Sidebar.tsx', import.meta.url), 'utf8');
  const actions = await readFile(new URL('../src/components/dashboard/sidebar-actions.ts', import.meta.url), 'utf8');
  assert.match(sidebar, /action=\{signOutAdministrativePanelAction\}/);
  assert.match(sidebar, /Sair da conta/);
  assert.match(actions, /supabase\.auth\.signOut\(\)/);
  assert.match(actions, /if \(error\) throw new Error/);
  assert.match(actions, /redirect\('\/entrar'\)/);
});

test('entrega distingue camiseta exibida de variante canonicamente vinculada', async () => {
  const page = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/page.tsx', import.meta.url), 'utf8');
  const controls = await readFile(new URL('../src/app/minha-conta/ingressos/[ticketId]/ticket-operational-controls.tsx', import.meta.url), 'utf8');
  assert.match(page, /shirtVariant\.variant_id/);
  assert.match(page, /ensure_ticket_kit_items/);
  assert.match(page, /ShirtContextAction[\s\S]*initial=\{currentShirtOption\}/);
  assert.doesNotMatch(page, /Confirmar vínculo da camiseta|vínculo operacional/);
  assert.match(page, /kitReadyForDelivery=\{!shirtKitItem \|\| shirtIsCanonicallyLinked\}/);
  assert.match(controls, /disabled=\{pending \|\| !props\.kitReadyForDelivery\}/);
  assert.match(controls, /O check-in pode ser realizado separadamente/);
});
