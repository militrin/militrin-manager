import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const MIGRATION = 'supabase/migrations/20261119000000_inventory_receipts.sql';

test('migration version unica e posterior ao maior existente', async () => {
  const files = await readdir(new URL('../supabase/migrations', import.meta.url));
  const versions = files.filter((name) => /^\d{14}_.+\.sql$/.test(name)).sort();
  assert.equal(files.includes('20261117000000_inventory_receipts.sql'), false);
  assert.equal(files.includes('20261119000000_inventory_receipts.sql'), true);
  assert.ok(files.includes('20261117000000_restore_same_name_holder_links.sql'));
  assert.ok(files.includes('20261118000000_list_operation_tickets.sql'));
  assert.equal(versions.at(-1), '20261119000000_inventory_receipts.sql');
  const sql = await read(MIGRATION);
  assert.match(sql, /Version 20261119000000/);
  assert.doesNotMatch(sql, /supabase db push/);
});

test('schema de receipt isola org/evento e live exige created_by', async () => {
  const sql = await read(MIGRATION);
  assert.match(sql, /organization_id uuid not null references public\.organizations\(id\)/);
  assert.match(sql, /event_id uuid not null references public\.events\(id\)/);
  assert.match(sql, /constraint inventory_receipts_status_check check \(status in \('posted', 'reversed'\)\)/);
  assert.match(sql, /origin in \('live', 'historical_backfill'\)/);
  assert.match(sql, /origin <> 'live' or created_by is not null/);
  assert.doesNotMatch(sql, /origin = 'historical_backfill' and created_by is null/);
  assert.match(sql, /constraint inventory_receipts_org_idempotency_key unique \(organization_id, idempotency_key\)/);
  assert.match(sql, /constraint inventory_receipt_items_quantity_check check \(quantity > 0\)/);
  assert.match(sql, /unique \(receipt_id, inventory_id\)/);
});

test('RPC create_inventory_receipt e atomica, com RBAC, operador, datas e overflow', async () => {
  const sql = await read(MIGRATION);
  const start = sql.indexOf('create or replace function public.create_inventory_receipt');
  const end = sql.indexOf('create or replace function public.list_event_inventory_receipts');
  const rpc = sql.slice(start, end);
  assert.match(rpc, /security definer/);
  assert.match(rpc, /v_actor uuid := auth\.uid\(\)/);
  assert.match(rpc, /current_user_has_permission\('inventory\.adjust'\)/);
  assert.match(rpc, /user_can_access_organization\(v_actor, v_event\.organization_id\)/);
  assert.match(rpc, /pg_advisory_xact_lock/);
  assert.match(rpc, /'live', v_actor, 'posted', p_idempotency_key/);
  assert.doesNotMatch(rpc, /p_created_by/);
  assert.match(rpc, /on conflict on constraint inventory_receipts_org_idempotency_key do nothing/);
  assert.match(rpc, /if v_receipt_id is null then[\s\S]*return v_receipt_id;/);
  assert.ok(rpc.indexOf('if v_receipt_id is null then') < rpc.indexOf('for v_item in'));
  assert.match(rpc, /Data de recebimento nao pode ser futura/);
  assert.match(rpc, /timezone\('America\/Sao_Paulo', now\(\)\)/);
  assert.match(rpc, /Data do pedido nao pode ser posterior ao recebimento/);
  assert.match(rpc, /2147483647/);
  assert.match(rpc, /jsonb_typeof\(elem->'quantity'\) is distinct from 'number'/);
  assert.match(rpc, /total_quantity = total_quantity \+ v_item\.quantity/);
  assert.doesNotMatch(rpc, /reserved_quantity/);
  assert.doesNotMatch(rpc, /delivered_quantity/);
  assert.match(rpc, /receipt_id/);
  assert.match(rpc, /'purchase'/);
  assert.match(rpc, /Linha de estoque nao pertence a organizacao do evento/);
  assert.match(rpc, /event_id is distinct from p_event_id/);
  assert.match(rpc, /inventory_receipt_created/);
  assert.match(rpc, /'actor_user_id', v_actor/);
});

test('list_event_inventory_receipts e historico do evento com view_history', async () => {
  const sql = await read(MIGRATION);
  const start = sql.indexOf('create or replace function public.list_event_inventory_receipts');
  const rpc = sql.slice(start, sql.indexOf('revoke all on function public.create_inventory_receipt'));
  assert.match(rpc, /current_user_has_permission\('inventory\.view_history'\)/);
  assert.match(rpc, /user_can_access_organization/);
  assert.match(rpc, /order by received_at desc, created_at desc/);
  assert.doesNotMatch(rpc, /limit 30/);
  assert.doesNotMatch(rpc, /inventory_movements/);
});

test('backfill so liga os 29 purchases esperados e nao altera estoque', async () => {
  const sql = await read(MIGRATION);
  assert.match(sql, /notes = 'Primeira Encomenda 11\/08'/);
  assert.match(sql, /'Segunda encomenda 22\/09'/);
  assert.match(sql, /'Segundo pedido \(o que faltava\) 23\/09'/);
  assert.match(sql, /16, 612/);
  assert.match(sql, /11, 161/);
  assert.match(sql, /2, 104/);
  assert.match(sql, /"Camiseta::M":53/);
  assert.match(sql, /"Camiseta::G":51/);
  assert.match(sql, /esperava 29 items/);
  assert.match(sql, /v_linked <> 29 or v_linked_qty <> 877/);
  assert.match(sql, /existem % purchases fora dos 3 grupos historicos/);
  assert.match(sql, /criou ou apagou purchase movements/);
  assert.match(sql, /total_quantity mudou ao vincular/);
  const helper = sql.slice(sql.indexOf('_backfill_historical_inventory_receipt'), sql.indexOf('do $backfill$'));
  assert.doesNotMatch(helper, /update public\.shirt_inventory/);
  assert.doesNotMatch(helper, /insert into public\.inventory_movements/);
});

test('writer legado e bloqueado; app nao chama add_inventory_quantity', async () => {
  const [sql, actions, table] = await Promise.all([
    read(MIGRATION),
    read('src/app/camisetas/actions.ts'),
    read('src/components/mvp/ShirtStockTable.tsx'),
  ]);
  assert.match(sql, /Entrada fisica deve ser registrada com create_inventory_receipt/);
  assert.match(sql, /create or replace function public\.add_inventory_quantity\(p_event_id uuid/);
  assert.doesNotMatch(actions, /addInventoryQuantityAction/);
  assert.doesNotMatch(actions, /rpc\("add_inventory_quantity"/);
  assert.doesNotMatch(table, /addInventoryQuantityAction/);
  assert.doesNotMatch(table, /Adicionar encomenda/);
});

test('reset simples preserva receipts; clear_history e bloqueado se houver receipt', async () => {
  const [sql, table] = await Promise.all([
    read(MIGRATION),
    read('src/components/mvp/ShirtStockTable.tsx'),
  ]);
  const start = sql.lastIndexOf('create or replace function public.reset_event_shirt_inventory');
  const rpc = sql.slice(start);
  assert.match(rpc, /existem entradas de estoque neste evento/);
  assert.match(rpc, /update public\.shirt_inventory[\s\S]*total_quantity = 0/);
  assert.doesNotMatch(rpc, /delete from public\.inventory_receipts/);
  assert.doesNotMatch(table, /Zerar estoque e limpar histórico/);
  assert.match(table, /histórico de entradas/);
});

test('actions validam datas, overflow e nao aceitam created_by do client', async () => {
  const actions = await read('src/app/camisetas/actions.ts');
  assert.match(actions, /createInventoryReceiptAction[\s\S]*assertPermission\("inventory\.adjust"\)/);
  assert.match(actions, /listEventInventoryReceiptsAction[\s\S]*assertPermission\("inventory\.view_history"\)/);
  assert.match(actions, /Data de recebimento não pode ser futura/);
  assert.match(actions, /Data do pedido não pode ser posterior ao recebimento/);
  assert.match(actions, /2147483647/);
  assert.doesNotMatch(actions, /p_created_by/);
  assert.match(actions, /Registro histórico/);
});

test('UI descobre entradas, recusa received_at futura e mantem movimentacoes tecnicas', async () => {
  const [table, form, history] = await Promise.all([
    read('src/components/mvp/ShirtStockTable.tsx'),
    read('src/app/camisetas/components/RegisterInventoryReceiptDialog.tsx'),
    read('src/app/camisetas/components/InventoryReceiptHistoryDialog.tsx'),
  ]);
  assert.match(table, /Registrar entrada/);
  assert.match(table, /Histórico de entradas/);
  assert.match(table, /Movimentações técnicas/);
  assert.match(table, /getInventoryMovementsAction/);
  assert.match(form, /idempotencyKeyRef/);
  assert.match(form, /disabled=\{isPending\}/);
  assert.match(form, /max=\{todayInEventTimeZone\(\)\}/);
  assert.match(form, /Data de recebimento não pode ser futura/);
  assert.match(form, /setFormError\("A descrição é obrigatória\."\)/);
  assert.match(form, /setFormError\("Data do pedido não pode ser posterior ao recebimento\."\)/);
  assert.match(form, /role="alert"/);
  assert.match(form, /setFormError\(result\.message\)/);
  assert.doesNotMatch(form, /onError\(/);
  assert.match(history, /listEventInventoryReceiptsAction/);
  assert.match(history, /role="alert"/);
});

test('getStock continua usando as fontes canônicas', async () => {
  const page = await read('src/app/camisetas/page.tsx');
  assert.match(page, /canonical\?\.reserved \?\? row\.reserved_quantity/);
  assert.match(page, /canonical\?\.delivered \?\? row\.delivered_quantity/);
  assert.match(page, /from\("event_kit_item_variant_inventory"\)/);
});
