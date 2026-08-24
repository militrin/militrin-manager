import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const permissions = await read('src/lib/dashboard/dashboard-permissions.ts');
const dashboard = await read('src/app/painel/page.tsx');
const details = await read('src/app/painel/detalhes/page.tsx');
const loader = await read('src/lib/dashboard/admin-dashboard-data.ts');
const menu = await read('src/lib/navigation/admin-menu.ts');
const migration = await read('supabase/migrations/20260878000000_dashboard_section_permissions.sql');

test('cinco blocos possuem permission codes independentes', () => {
  for (const code of ['dashboard.integrity.view', 'dashboard.people.view', 'dashboard.operations.view', 'dashboard.inventory.view', 'dashboard.finance.view']) {
    assert.match(permissions, new RegExp(code.replaceAll('.', '\\.')));
    assert.match(migration, new RegExp(code.replaceAll('.', '\\.')));
  }
});

test('cada secao renderiza somente sob sua permissao efetiva', () => {
  assert.match(dashboard, /canViewIntegritySection \? <AdminSection compact title="Integridade operacional"/);
  assert.match(dashboard, /sectionAccess\.people \? <AdminSection compact title="Pessoas e inscrições"/);
  assert.match(dashboard, /sectionAccess\.operations && data\.hasData \? <AdminSection compact title="Ingressos e operação"/);
  assert.match(dashboard, /sectionAccess\.inventory && data\.hasData \? <AdminSection compact title="Estoque de camisetas"/);
  assert.match(dashboard, /canViewFinanceSection \? <AdminSection compact title="Financeiro"/);
});

test('dados de blocos nao autorizados nao sao consultados no servidor', () => {
  assert.match(dashboard, /loadAdminDashboard\(eventId, authorizedSections\)/);
  assert.match(loader, /enabled\.has\('finance'\) \? scope\(supabase\.from\('payments'\)/);
  assert.match(loader, /enabled\.has\('inventory'\) \? scope\(supabase\.from\('shirt_inventory'\)/);
  assert.match(loader, /enabled\.has\('operations'\) \? scope\(supabase\.from\('tickets'\)/);
  assert.match(dashboard, /canViewIntegritySection[\s\S]*getIntegrityReportAction/);
});

test('detalhes exige a permissao do bloco antes de carregar dados', () => {
  const guard = details.indexOf('await requirePermission(DASHBOARD_SECTION_PERMISSIONS[section])');
  const load = details.indexOf('await loadAdminDashboard');
  assert.ok(guard >= 0 && guard < load);
  assert.match(details, /section === 'finance'[\s\S]*requirePermission\('finance\.view_amounts'\)/);
});

test('landing aceita qualquer bloco novo e nao depende de dashboard.view', () => {
  const dashboardItem = menu.slice(menu.indexOf('label: "Dashboard"'), menu.indexOf('label: "Integridade"'));
  for (const code of ['dashboard.integrity.view', 'dashboard.people.view', 'dashboard.operations.view', 'dashboard.inventory.view', 'dashboard.finance.view']) assert.match(dashboardItem, new RegExp(code.replaceAll('.', '\\.')));
  assert.doesNotMatch(dashboardItem, /"dashboard\.view"/);
});

test('migration preserva overrides e resolve_user_permission', () => {
  assert.doesNotMatch(migration, /admin_user_permission_overrides/);
  assert.doesNotMatch(migration, /create or replace function public\.resolve_user_permission/);
  assert.match(migration, /admin_role_permissions_system_default/);
});

test('presets do Dashboard usam somente as seis roles finais', () => {
  const preset = migration.slice(migration.indexOf('with preset(role_code, permission_code)'), migration.indexOf('), inserted as'));
  for (const legacy of ['manager', 'inventory', 'checkin', 'kit_delivery', 'support']) assert.doesNotMatch(preset, new RegExp(`'${legacy}'`));
  assert.match(preset, /'operational', 'dashboard\.people\.view'/);
  assert.match(preset, /'operational', 'dashboard\.operations\.view'/);
  assert.match(preset, /'viewer', 'dashboard\.people\.view'/);
  assert.match(preset, /'viewer', 'dashboard\.operations\.view'/);
  assert.doesNotMatch(preset, /'marketing', 'dashboard\./);
});
