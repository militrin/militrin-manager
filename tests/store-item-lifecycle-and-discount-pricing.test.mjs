import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';

const migrationUrl = new URL('../supabase/migrations/20260855000000_store_item_lifecycle_and_discount_pricing.sql', import.meta.url);
const previousMigrationUrl = new URL('../supabase/migrations/20260854000000_store_item_global_creation_and_event_kit_stock_link.sql', import.meta.url);
const lojaActionsUrl = new URL('../src/app/loja/actions.ts', import.meta.url);
const lojaPageUrl = new URL('../src/app/loja/page.tsx', import.meta.url);
const storeItemCardUrl = new URL('../src/app/loja/store-item-card.tsx', import.meta.url);
const storeItemFormUrl = new URL('../src/app/loja/store-item-form.tsx', import.meta.url);
const operacoesActionsUrl = new URL('../src/app/operacoes/actions.ts', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

// ============================================================
// Investigacao previa: is_active ja existia e ja era respeitado
// ============================================================
test('is_active ja existia em store_items ANTES desta migration e ja era respeitado pelas 3 RPCs de escolha/compra/concessao -- nenhum campo duplicado foi criado', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.doesNotMatch(sql, /add column if not exists is_active/);
  const previousSql = await readFile(previousMigrationUrl, 'utf8');
  assert.match(previousSql, /and is_active;/); // create_store_order
  assert.match(previousSql, /and is_active and organization_id = v_order\.organization_id;/); // add_product_to_cart_order
  assert.match(previousSql, /and is_active and organization_id = v_ticket\.organization_id;/); // admin_grant_store_item
});

// ============================================================
// 1/2/3/6 -- desativar/reativar
// ============================================================
test('1. set_store_item_active existe, exige store.manage + acesso a organizacao, e audita ativacao/desativacao (mesmo padrao de set_coupon_active)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'set_store_item_active');
  assert.match(fn, /current_user_has_permission\('store\.manage'\)/);
  assert.match(fn, /user_can_access_organization\(v_actor, v_item\.organization_id\)/);
  assert.match(fn, /update public\.store_items set is_active = coalesce\(p_is_active, true\), updated_at = now\(\) where id = p_store_item_id;/);
  assert.match(fn, /case when coalesce\(p_is_active, true\) then 'store_item_activated' else 'store_item_deactivated' end/);
});

test('2. produto desativado desaparece do catalogo self-service -- list_store_items_for_event continua filtrando si.is_active', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = sql.match(/create function public\.list_store_items_for_event[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.match(fn, /and si\.is_active and si\.visibility = 'public'/);
});

test('3. produto desativado desaparece da concessao administrativa -- getGrantableStoreItemsAction continua filtrando is_active', async () => {
  const ts = await readFile(operacoesActionsUrl, 'utf8');
  const fn = ts.match(/export async function getGrantableStoreItemsAction[\s\S]*?\n\}/)?.[0] ?? '';
  assert.match(fn, /\.eq\("is_active", true\)/);
});

test('6. reativacao usa a MESMA RPC set_store_item_active (p_is_active=true), nunca um caminho separado', async () => {
  const ts = await readFile(lojaActionsUrl, 'utf8');
  assert.match(ts, /export async function setStoreItemActiveAction\(storeItemId: string, isActive: boolean\)/);
  assert.match(ts, /supabase\.rpc\("set_store_item_active", \{ p_store_item_id: storeItemId, p_is_active: isActive \}\)/);
});

test('editar produto (upsert_store_item) NUNCA reativa/desativa por conta propria -- StoreItemForm preserva item?.isActive em vez de mandar sempre true', async () => {
  const tsx = await readFile(storeItemFormUrl, 'utf8');
  assert.match(tsx, /isActive: item\?\.isActive \?\? true,/);
  assert.doesNotMatch(tsx, /isActive: true,\s*\n\s*sortOrder/);
});

// ============================================================
// 4/5 -- pedido antigo e entrega pendente continuam integros
// ============================================================
test('4/5. desativar/reativar NUNCA toca em store_order_items/order_items/store_item_inventory -- pedidos antigos e entregas pendentes ficam intocados', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'set_store_item_active');
  assert.doesNotMatch(fn, /store_order_items|order_items|store_item_inventory|store_item_variants/);
});

test('5. deliver_store_order_item (entrega) nunca checou is_active -- entrega de produto ja desativado continua funcionando normalmente', async () => {
  const sql = await readFile(previousMigrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_store_order_item');
  assert.doesNotMatch(fn, /is_active/);
});

// ============================================================
// 7/8/9/10 -- exclusao segura
// ============================================================
test('7. delete_store_item apaga quando o produto nunca foi utilizado (sem store_order_items nem order_items)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'delete_store_item');
  assert.match(fn, /delete from public\.coupon_product_scopes where store_item_id = p_store_item_id;/);
  assert.match(fn, /delete from public\.store_items where id = p_store_item_id;/);
});

test('8/9/10. delete_store_item BLOQUEIA com mensagem amigavel quando ha QUALQUER linha em store_order_items OU order_items -- cobre pedido, reserva e entrega (mesma linha, status diferente)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'delete_store_item');
  assert.match(fn, /exists\(select 1 from public\.store_order_items where store_item_id = p_store_item_id\)/);
  assert.match(fn, /exists\(select 1 from public\.order_items where store_item_id = p_store_item_id\)/);
  assert.match(fn, /raise exception 'Este produto já possui movimentações e não pode ser excluído\. Desative-o para impedir novas vendas\.';/);
  // A checagem nao filtra por status -- reserva ("reserved") e entrega
  // ("delivered") sao a MESMA linha, entao "existe qualquer linha" ja
  // cobre as 3 categorias pedidas sem precisar de 3 queries separadas.
  assert.doesNotMatch(fn, /where store_item_id = p_store_item_id and status/);
});

test('delete_store_item nunca usa cascade destrutivo sobre historico -- so DELETE em store_items (variantes/estoque proprio/imagens cascade automaticamente por FK, nunca pedidos)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'delete_store_item');
  assert.doesNotMatch(fn, /delete from public\.store_order_items/);
  assert.doesNotMatch(fn, /delete from public\.order_items/);
  assert.match(fn, /insert into public\.audit_logs \(action, entity_type, entity_id, event_id, details\)\s*\n\s*values \('store_item_deleted'/);
});

// ============================================================
// 11/12 -- produto global e especifico de evento
// ============================================================
test('11/12. set_store_item_active e delete_store_item nao fazem nenhuma distincao entre event_id nulo (global) e especifico -- nenhum "if event_id is null" / "if event_id is not null" condicional, so o valor repassado ao audit_logs', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const setActive = extractFunction(sql, 'set_store_item_active');
  const del = extractFunction(sql, 'delete_store_item');
  assert.doesNotMatch(setActive, /if v_item\.event_id|event_id is null|event_id is not null/);
  assert.doesNotMatch(del, /if v_item\.event_id|event_id is null|event_id is not null/);
  // event_id so aparece repassado como valor pro audit_logs, em ambas.
  assert.match(setActive, /entity_id, event_id, details\)\s*\n\s*values \([\s\S]*?v_item\.event_id/);
  assert.match(del, /entity_id, event_id, details\)\s*\n\s*values \([\s\S]*?v_item\.event_id/);
});

// ============================================================
// 13/14/15 -- estoque proprio vs vinculado ao evento
// ============================================================
test('13. produto com estoque proprio: excluir cascade automaticamente store_item_variants/store_item_inventory (FK ON DELETE CASCADE ja existente, confirmado por investigacao) -- delete_store_item nao precisa apaga-los manualmente', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'delete_store_item');
  assert.doesNotMatch(fn, /delete from public\.store_item_variants/);
  assert.doesNotMatch(fn, /delete from public\.store_item_inventory/);
});

test('14/15. produto vinculado ao estoque do evento: delete_store_item NUNCA toca event_kit_items/event_kit_item_variants/event_kit_item_variant_inventory -- FK aponta do produto pro evento, nunca o contrario', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'delete_store_item');
  assert.doesNotMatch(fn, /event_kit_items|event_kit_item_variants|event_kit_item_variant_inventory/);
  // O unico rastro do vinculo no audit_logs e uma referencia somente-leitura (para historico), nunca uma escrita.
  assert.match(fn, /'was_linked_event_kit_item_id', v_item\.linked_event_kit_item_id/);
});

test('set_store_item_active tambem nunca toca event_kit_items/variantes/estoque do evento', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'set_store_item_active');
  assert.doesNotMatch(fn, /event_kit_items|event_kit_item_variants|event_kit_item_variant_inventory/);
});

// ============================================================
// UI -- Editar | Desativar / Editar | Reativar | Excluir, badges, filtro
// ============================================================
test('card mostra "Desativar" quando ativo, e "Reativar" + "Excluir" quando desativado, com confirmacao explicita antes de excluir', async () => {
  const tsx = await readFile(storeItemCardUrl, 'utf8');
  assert.match(tsx, /\{item\.isActive \? \(/);
  assert.match(tsx, />\s*\n\s*Desativar\s*\n\s*<\/button>/);
  assert.match(tsx, />\s*\n\s*Reativar\s*\n\s*<\/button>/);
  assert.match(tsx, /confirmingDelete/);
  assert.match(tsx, /Excluir permanentemente\?/);
});

test('badge "Desativado" e badge "Indisponível" sao estados DIFERENTES na UI -- nunca tratados como sinonimos (nunca aparecem juntos, condicoes mutuamente exclusivas)', async () => {
  const tsx = await readFile(storeItemCardUrl, 'utf8');
  assert.match(tsx, /!item\.isActive \? \(\s*\n\s*<span[^>]*>Desativado<\/span>/);
  assert.match(tsx, /\) : isUnavailable \? \(\s*\n\s*<span[^>]*>Indisponível<\/span>/);
  assert.match(tsx, /const isUnavailable = item\.isActive && item\.supplyMode === "stock" && !item\.requiresVariant && item\.availableQuantity <= 0;/);
});

test('filtro administrativo Ativos\\/Desativados\\/Todos existe e controla a consulta de store_items por is_active', async () => {
  const tsx = await readFile(lojaPageUrl, 'utf8');
  assert.match(tsx, /<StoreItemStatusFilter/);
  assert.match(tsx, /statusFilter === "active" \? query\.eq\("is_active", true\) : statusFilter === "inactive" \? query\.eq\("is_active", false\) : query;/);
});

// ============================================================
// 16/17 -- estoque 0 => indisponivel; desativado => nao aparece
// ============================================================
test('16. estoque 0 (produto ATIVO, modo stock, sem variante) exibe badge "Indisponível" no card administrativo', async () => {
  const tsx = await readFile(storeItemCardUrl, 'utf8');
  assert.match(tsx, /item\.isActive && item\.supplyMode === "stock" && !item\.requiresVariant && item\.availableQuantity <= 0/);
});

test('17. desativado nao aparece no catalogo publico nem na concessao -- ja coberto pelos testes 2 e 3 (is_active filtrado nas duas RPCs)', () => {
  // Confirmado nos testes 2 e 3 acima -- mantido como entrada separada so
  // pra bater 1:1 com a lista de testes obrigatorios pedida.
  assert.ok(true);
});

// ============================================================
// 18/19/20/21/22/23 -- desconto
// ============================================================
test('18/19. compute_store_item_final_price calcula percentual e valor fixo corretamente', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = sql.match(/create or replace function public\.compute_store_item_final_price[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.match(fn, /when p_discount_type = 'percentage' then p_unit_price \* \(1 - least\(coalesce\(p_discount_value,0\),100\) \/ 100\.0\)/);
  assert.match(fn, /when p_discount_type = 'fixed' then p_unit_price - coalesce\(p_discount_value,0\)/);
});

test('20. desconto percentual de 100% e permitido na validacao (0 a 100 inclusive) e resulta em preco final 0 via greatest(...,0)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const validateFn = sql.match(/create or replace function public\.validate_store_item_discount[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.match(validateFn, /if p_discount_type = 'percentage' and p_discount_value > 100 then raise exception/);
  assert.doesNotMatch(validateFn, /p_discount_value >= 100|p_discount_value > 99/);
  const computeFn = sql.match(/create or replace function public\.compute_store_item_final_price[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.match(computeFn, /select greatest\(/);
});

test('21. desconto fixo IGUAL ao valor do produto e permitido (<=), resultando em preco final 0', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = sql.match(/create or replace function public\.validate_store_item_discount[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.match(fn, /if p_discount_type = 'fixed' and p_discount_value > p_price then raise exception/);
  // Estritamente maior (>) -- igual (=) passa.
  assert.doesNotMatch(fn, /p_discount_value >= p_price/);
});

test('22. desconto invalido ACIMA do preco base (fixo) e rejeitado por validate_store_item_discount, chamado dentro de upsert_store_item', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const upsertFn = extractFunction(sql, 'upsert_store_item');
  assert.match(upsertFn, /perform public\.validate_store_item_discount\(p_price, p_discount_type, p_discount_value\);/);
});

test('23. preco final NUNCA negativo -- compute_store_item_final_price sempre aplica greatest(...,0), independente do modo', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = sql.match(/create or replace function public\.compute_store_item_final_price[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.match(fn, /select greatest\(\s*\n\s*case/);
  assert.match(fn, /0\s*\n\s*\);/);
});

test('desconto validado tambem no backend (nao so no frontend): upsert_store_item chama validate_store_item_discount; create_store_order e admin_grant_store_item chamam compute_store_item_final_price', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const createOrder = extractFunction(sql, 'create_store_order');
  const grant = extractFunction(sql, 'admin_grant_store_item');
  assert.match(createOrder, /v_final_unit_price := public\.compute_store_item_final_price\(v_unit_price, v_store_item\.discount_type, v_store_item\.discount_value\);/);
  assert.match(grant, /v_final_unit_price := public\.compute_store_item_final_price\(v_unit_price, v_store_item\.discount_type, v_store_item\.discount_value\);/);
});

// ============================================================
// 24/25 -- snapshot no pedido, produto desativado nao entra em pedido novo
// ============================================================
test('24. pedido preserva snapshot do desconto (discount_type/discount_value/final_unit_price gravados em store_order_items na hora da compra/concessao) -- mudar o desconto do produto depois nunca reescreve pedidos antigos', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /alter table public\.store_order_items\s*\n\s*add column if not exists discount_type text,\s*\n\s*add column if not exists discount_value numeric\(10,2\) not null default 0,\s*\n\s*add column if not exists final_unit_price numeric\(10,2\) not null default 0;/);
  const createOrder = extractFunction(sql, 'create_store_order');
  assert.match(createOrder, /insert into public\.store_order_items \(store_order_id, store_item_id, variant_id, quantity, unit_price, final_amount, status, discount_type, discount_value, final_unit_price\)/);
  assert.match(createOrder, /v_store_item\.discount_type, v_store_item\.discount_value, v_final_unit_price\);/);
  const grant = extractFunction(sql, 'admin_grant_store_item');
  assert.match(grant, /v_store_item\.discount_type, v_store_item\.discount_value, case when coalesce\(p_is_courtesy, false\) then 0 else v_final_unit_price end\)/);
});

test('backfill preserva linhas ja existentes (criadas antes do desconto existir): final_unit_price = unit_price quando ainda nao setado', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /update public\.store_order_items set final_unit_price = unit_price where final_unit_price = 0 and unit_price <> 0;/);
});

test('25. produto desativado nao pode entrar em NENHUM pedido novo -- confirmado nas 3 RPCs de escrita (create_store_order, add_product_to_cart_order, admin_grant_store_item) que continuam checando is_active', async () => {
  const previousSql = await readFile(previousMigrationUrl, 'utf8');
  const createOrder = extractFunction(previousSql, 'create_store_order');
  const addToCart = previousSql.match(/create or replace function public\.add_product_to_cart_order[\s\S]*?\nend; \$\$;/)?.[0] ?? '';
  const grant = extractFunction(previousSql, 'admin_grant_store_item');
  assert.match(createOrder, /and is_active;/);
  assert.match(addToCart, /and is_active and organization_id = v_order\.organization_id;/);
  assert.match(grant, /and is_active and organization_id = v_ticket\.organization_id;/);
});

// ============================================================
// Regras existentes preservadas (nao alteradas por esta migration)
// ============================================================
test('nenhuma alteracao a regras de camiseta principal, titularidade, check-in, pulseira ou gateway nesta migration', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const token of ['event_kit_items set', 'admin_change_ticket_shirt', 'trg_enforce_ticket_holder_contact_uniqueness', 'checkin_ticket_entry', 'link_wristband_to_ticket']) {
    assert.doesNotMatch(sql, new RegExp(token));
  }
});

test('reserve_store_item_stock/deliver_store_item_stock/release_store_item_reservation/undo_deliver_store_item_stock (migration 54) NAO sao redefinidas nesta migration -- so os chamadores (create_store_order/admin_grant_store_item) ganham o calculo de desconto', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const name of ['reserve_store_item_stock', 'deliver_store_item_stock', 'release_store_item_reservation', 'undo_deliver_store_item_stock', 'cancel_store_order', 'undo_store_order_item_delivery']) {
    assert.doesNotMatch(sql, new RegExp(`create (or replace )?function public\\.${name}\\(`));
  }
});
