import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('rotas filhas do painel revalidam a permissao especifica em acesso direto', async () => {
  const routes = [
    ['src/app/painel/page.tsx', 'requireDashboardAccess'],
    ['src/app/painel/detalhes/page.tsx', 'DASHBOARD_SECTION_PERMISSIONS'],
    ['src/app/painel/eventos/page.tsx', 'events.view'],
    ['src/app/painel/eventos/[id]/page.tsx', 'events.view'],
    ['src/app/painel/eventos/novo/page.tsx', 'events.create'],
    ['src/app/painel/cronograma-entregas/page.tsx', 'events.view'],
  ];
  for (const [path, permission] of routes) {
    assert.match(await read(path), new RegExp(permission.replace('.', '\\.')), path);
  }
});

test('estoque com inventory.view permanece somente leitura sem inventory.adjust/view_history', async () => {
  const [page, table, actions] = await Promise.all([
    read('src/app/camisetas/page.tsx'),
    read('src/components/mvp/ShirtStockTable.tsx'),
    read('src/app/camisetas/actions.ts'),
  ]);
  assert.match(page, /"inventory\.adjust"/);
  assert.match(page, /"inventory\.view_history"/);
  assert.match(table, /canAdjustInventory \? <div/);
  assert.match(table, /canViewHistory \? \(/);
  assert.match(table, /Somente leitura/);
  assert.match(actions, /addInventoryQuantityAction[\s\S]*assertPermission\("inventory\.adjust"\)/);
  assert.doesNotMatch(actions, /inventory\.add_order/);
});

test('inventory.clear_history depende do permission code, sem excecao Owner hardcoded na aplicacao', async () => {
  const actions = await read('src/app/camisetas/actions.ts');
  assert.match(actions, /assertPermission\("inventory\.clear_history"\)/);
  assert.doesNotMatch(actions, /is_active_owner|apenas Owner pode limpar/);
});

test('lista de eventos separa capacidades de criar editar publicar e arquivar', async () => {
  const [page, manager] = await Promise.all([
    read('src/app/painel/eventos/page.tsx'),
    read('src/app/eventos/ui.tsx'),
  ]);
  for (const permission of ['events.create', 'events.edit', 'events.publish', 'events.archive']) assert.match(page, new RegExp(permission.replace('.', '\\.')));
  assert.match(manager, /canCreate \? <Link href="\/painel\/eventos\/novo"/);
  assert.match(manager, /!item\.archived_at && canEdit \? <Link/);
  assert.match(manager, /!item\.archived_at && canPublish \? <button/);
  assert.match(manager, /canArchive && !item\.archived_at \? <button/);
});

test('server actions administrativas revalidam permissao antes das RPCs', async () => {
  const [events, categories, batches, coupons, finance] = await Promise.all([
    read('src/app/eventos/actions.ts'), read('src/app/categorias/actions.ts'), read('src/app/lotes/actions.ts'),
    read('src/app/cupons/actions.ts'), read('src/app/financeiro/actions.ts'),
  ]);
  assert.match(events, /createEventAction[\s\S]*assertPermission\("events\.create"\)/);
  assert.match(events, /activateEventAction[\s\S]*assertPermission\("events\.publish"\)/);
  assert.match(categories, /createCategoryAction[\s\S]*assertPermission\("categories\.create"\)/);
  assert.match(batches, /activateBatchAction[\s\S]*assertPermission\("batches\.activate"\)/);
  assert.match(coupons, /createCouponAction[\s\S]*assertPermission\("coupons\.create"\)/);
  assert.match(finance, /settleSimpleFinancialExpenseAction[\s\S]*assertPermission\("finance\.confirm_payment"\)/);
});

test('categorias lotes e cupons nao montam editores para perfis somente leitura', async () => {
  const pages = await Promise.all(['categorias', 'lotes', 'cupons'].map((name) => read(`src/app/${name}/page.tsx`)));
  for (const source of pages) {
    assert.match(source, /const canManage = Object\.values\(permissions\)\.some\(Boolean\)/);
    assert.match(source, /canManage \? </);
  }
});
