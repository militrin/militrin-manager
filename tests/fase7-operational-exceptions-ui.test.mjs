import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('dashboard e detalhes expõem kit entregue sem check-in', async () => {
  const [data, dashboard, details, permissions] = await Promise.all([
    read('src/lib/dashboard/admin-dashboard-data.ts'),
    read('src/app/painel/page.tsx'),
    read('src/app/painel/detalhes/page.tsx'),
    read('src/lib/dashboard/dashboard-permissions.ts'),
  ]);
  assert.match(data, /put\('kit_without_checkin', 'Kit entregue sem check-in'/);
  assert.match(data, /actionLabel: 'Abrir na Central'/);
  assert.match(data, /operationsTicketHref/);
  assert.doesNotMatch(data, /Amanda Borges/);
  assert.match(dashboard, /Kit entregue sem check-in/);
  assert.match(dashboard, /href=\{href\('kit_without_checkin'\)\}/);
  assert.match(details, /kit_without_checkin/);
  assert.match(details, /RELATED_OPERATION_VIEWS/);
  assert.match(permissions, /kit_without_checkin: 'operations'/);
});

test('cards de kits e check-ins apontam para a mesma excecao', async () => {
  const [dashboard, details] = await Promise.all([
    read('src/app/painel/page.tsx'),
    read('src/app/painel/detalhes/page.tsx'),
  ]);
  assert.match(dashboard, /metric\('checkins'\).*hint=\{metric\('kit_without_checkin'\)/s);
  assert.match(dashboard, /metric\('complete_kits'\).*hint=\{metric\('kit_without_checkin'\)/s);
  assert.match(details, /complete_kits: \['complete_kits', 'kit_without_checkin'\]/);
  assert.match(details, /checkins: \['checkins', 'kit_without_checkin', 'checkin_without_kit'\]/);
});

test('Central aplica filtro canonico kit entregue + check-in pendente', async () => {
  const [page, filters] = await Promise.all([
    read('src/app/operacoes/page.tsx'),
    read('src/app/operacoes/components/OperationsFilters.tsx'),
  ]);
  assert.match(page, /applyOperationUrlFilters/);
  assert.match(page, /kitStatus === "delivered"/);
  assert.match(page, /checkinStatus === "pending"/);
  assert.match(page, /focusTicket/);
  assert.match(filters, /Kit entregue sem check-in/);
  assert.match(filters, /onFilterChange\("kitStatus", "delivered"\)/);
  assert.match(filters, /onFilterChange\("checkinStatus", "pending"\)/);
});
