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
  assert.match(source, /put\('confirmed', 'Ingressos ativos', activeTickets\.length/);
  assert.match(source, /put\('cancelled', 'Cancelados', cancelledTickets\.length/);
  assert.match(source, /put\('tickets', 'Ingressos emitidos', tickets\.length/);
  assert.match(source, /registration_contacts\(id,full_name\)/);
  assert.match(source, /participant_data_issues'\)\.select\('id,event_id,participant_id/);
  assert.doesNotMatch(source, /participant_data_issues'\)\.select\([^']*order_item_id/);
});

// Auditoria da Central de Integridade: produto "compre junto" (order_items.
// item_kind='product') nunca deve inflar "Inscrições comerciais" nem
// aparecer rotulado "Ingresso único" nas métricas do Dashboard. items e
// filtrado uma unica vez, logo apos a leitura, antes de qualquer put(...)
// -- nao uma heuristica por metrica.
test('dashboard filtra order_items por item_kind=ticket antes de calcular qualquer metrica de inscricao', async () => {
  const source = await read('src/lib/dashboard/admin-dashboard-data.ts');
  const itemsDeclarationIndex = source.indexOf("const items = allOrderItems.filter((item) => (item.item_kind ?? 'ticket') === 'ticket');");
  assert.ok(itemsDeclarationIndex >= 0, 'items deve ser filtrado por item_kind logo na leitura de itemsResult');
  const firstPutIndex = source.indexOf("put('registrations'");
  assert.ok(firstPutIndex > itemsDeclarationIndex, 'o filtro por item_kind precisa vir ANTES de qualquer metrica usar items');
  assert.match(source, /supabase\.from\('order_items'\)\.select\('id,event_id,status,item_kind,/);
});

test('shirt stock follows canonical reserved demand and free-to-reserve semantics', async () => {
  const source = await read('src/lib/dashboard/admin-dashboard-data.ts');
  assert.match(source, /kit\.variant_data\?\.variant_id/);
  assert.match(source, /kitsByTicket/);
  assert.match(source, /reservedShirtTotal\(kitPendingReserved, additionalReserved\)/);
  assert.match(source, /put\('shirts_additional', 'Camisetas adicionais'/);
  assert.match(source, /rowBalance/);
  assert.match(source, /put\('shirts_available', 'Saldo líquido'/);
  assert.match(source, /put\('shirts_deficit', 'Falta encomendar'/);
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
