import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('dashboard and details share the same canonical metric loader', async () => {
  const [dashboard, details] = await Promise.all([
    read('src/app/painel/page.tsx'),
    read('src/app/painel/detalhes/page.tsx'),
  ]);
  assert.match(dashboard, /loadAdminDashboard\(eventId, authorizedSections\)/);
  assert.match(details, /loadAdminDashboard\(params\.eventId, \[section\]\)/);
  assert.doesNotMatch(dashboard, /registration_status|participantsQuery|final_amount.*participants/);
});

test('canonical dashboard separates people, commercial items and tickets', async () => {
  const source = await read('src/lib/dashboard/admin-dashboard-data.ts');
  assert.match(source, /put\('people', 'Pessoas no evento', people\.size/);
  assert.match(source, /put\('registrations', 'Inscrições comerciais', items\.length/);
  assert.match(source, /put\('tickets', 'Ingressos emitidos', tickets\.length/);
  assert.match(source, /registration_contacts\(full_name\)/);
  assert.match(source, /participant_data_issues'\)\.select\('id,event_id,participant_id/);
  assert.doesNotMatch(source, /participant_data_issues'\)\.select\([^']*order_item_id/);
});

test('shirt stock and consistency follow physical and ticket-first semantics', async () => {
  const source = await read('src/lib/dashboard/admin-dashboard-data.ts');
  assert.match(source, /total_quantity \?\? 0\) - Number\(row\.delivered_quantity/);
  assert.match(source, /kit\.variant_data\?\.variant_id/);
  assert.match(source, /kitsByTicket/);
  assert.doesNotMatch(source, /total_quantity \?\? 0\) - Number\(row\.reserved_quantity[^\n]+row\.delivered_quantity/);
});

test('cards are traceable and sensitive actions keep RBAC', async () => {
  const [card, dashboard, details, source] = await Promise.all([
    read('src/components/admin/AdminStatCard.tsx'),
    read('src/app/painel/page.tsx'),
    read('src/app/painel/detalhes/page.tsx'),
    read('src/lib/dashboard/admin-dashboard-data.ts'),
  ]);
  assert.match(card, /<Link href=\{href\}/);
  assert.match(dashboard, /dashboardDetailHref/);
  assert.match(details, /grantedPermissions\.has\(row\.requiredPermission\)/);
  assert.match(source, /requiredPermission = 'participants\.edit_basic'/);
  assert.match(source, /requiredPermission = 'finance\.confirm_payment'/);
  assert.match(source, /requiredPermission = 'inventory\.change_participant_shirt'/);
});
