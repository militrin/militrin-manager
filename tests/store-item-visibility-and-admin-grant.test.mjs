import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';

const migrationUrl = new URL('../supabase/migrations/20260853000000_store_item_visibility_and_admin_grant.sql', import.meta.url);
const baselineSchemaUrl = new URL('../supabase/migrations/20260815001914_remote_schema.sql', import.meta.url);
const operacoesActionsUrl = new URL('../src/app/operacoes/actions.ts', import.meta.url);
const operacoesTypesUrl = new URL('../src/app/operacoes/types.ts', import.meta.url);
const expandedTicketDetailsUrl = new URL('../src/app/operacoes/components/ExpandedTicketDetails.tsx', import.meta.url);
const grantModalUrl = new URL('../src/app/operacoes/components/GrantStoreItemModal.tsx', import.meta.url);
const storeItemFormUrl = new URL('../src/app/loja/store-item-form.tsx', import.meta.url);
const storeItemCardUrl = new URL('../src/app/loja/store-item-card.tsx', import.meta.url);
const lojaActionsUrl = new URL('../src/app/loja/actions.ts', import.meta.url);
const lojaPageUrl = new URL('../src/app/loja/page.tsx', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

// Confirma que a tarefa nao toca em nada da migration 52 / camiseta principal.
test('nao altera nenhuma estrutura da camiseta principal listada como fora de escopo', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const forbidden = [
    'event_kit_items', 'event_kit_item_variant_inventory', 'shirt_inventory',
    'limit_shirt_selection_to_stock', 'admin_change_ticket_shirt', 'admin_correct_ticket_shirt_after_operation',
    'trg_enforce_ticket_holder_contact_uniqueness',
  ];
  for (const token of forbidden) {
    assert.doesNotMatch(sql, new RegExp(`(alter|create or replace function public\\.)[^\\n]*${token}`, 'i'), `migration nao deveria mencionar ${token}`);
  }
});

test('nao cria tabela nova -- reaproveita store_items/store_item_variants/store_item_inventory/store_orders/store_order_items', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.doesNotMatch(sql, /create table/i);
});

// PARTE A -- visibilidade
test('store_items ganha coluna visibility (public/code_required/admin_only), sem duplicar campo equivalente', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /alter table public\.store_items\s*\n\s*add column if not exists visibility text not null default 'public';/);
  assert.match(sql, /check \(visibility in \('public','code_required','admin_only'\)\)/);
});

test('1. list_store_items_for_event (catalogo self-service) so retorna itens visibility=public', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = sql.match(/create function public\.list_store_items_for_event[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.notEqual(fn, '');
  assert.match(fn, /and si\.is_active and si\.visibility = 'public'/);
});

test('2. admin_only nao aparece no catalogo self-service -- confirmado pela mesma condicao acima (visibility=public exclui admin_only e code_required)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = sql.match(/create function public\.list_store_items_for_event[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.doesNotMatch(fn, /visibility in \('public','admin_only'\)/);
  assert.doesNotMatch(fn, /visibility <> 'admin_only'/);
});

test('defesa em profundidade: create_store_order e add_product_to_cart_order (checkout self-service) rejeitam item que nao seja public, mesmo chamados diretamente', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const createOrder = extractFunction(sql, 'create_store_order');
  assert.match(createOrder, /if v_store_item\.visibility <> 'public' then raise exception 'Item % nao esta disponivel para compra publica\.', v_store_item\.name; end if;/);
  const addToCart = sql.match(/create or replace function public\.add_product_to_cart_order[\s\S]*?\nend; \$\$;/)?.[0] ?? '';
  assert.notEqual(addToCart, '');
  assert.match(addToCart, /if v_store_item\.visibility <> 'public' then raise exception 'Produto nao esta disponivel para compra publica\.'; end if;/);
});

test('9/11. upsert_store_item aceita p_visibility (default public) e permite mudar admin_only -> public sem recriar produto, sem mexer em estoque/variantes/pedidos', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /drop function if exists public\.upsert_store_item\(uuid, uuid, text, text, text, numeric, boolean, boolean, integer, text, boolean\);/);
  const fn = extractFunction(sql, 'upsert_store_item');
  assert.match(fn, /p_visibility text default 'public'/);
  assert.match(fn, /visibility = coalesce\(p_visibility, 'public'\), updated_at = now\(\)\s*\n\s*where id = p_id/);
  // E so um UPDATE em store_items -- nunca toca em variants/inventory/orders.
  assert.doesNotMatch(fn, /store_item_variants|store_item_inventory|store_orders|store_order_items/);
});

test('UI administrativa: radio "Visibilidade do produto" com as 3 opcoes e descricoes claras', async () => {
  const tsx = await readFile(storeItemFormUrl, 'utf8');
  assert.match(tsx, /Visibilidade do produto/);
  assert.match(tsx, /Público<\/span>/);
  assert.match(tsx, /Aparece normalmente na loja\. Qualquer usuário elegível pode comprar\./);
  assert.match(tsx, /Somente com código<\/span>/);
  assert.match(tsx, /O usuário precisa informar um código válido para liberar a compra\./);
  assert.match(tsx, /Somente administrativo<\/span>/);
  assert.match(tsx, /Só um administrador pode conceder este item para um participante\./);
  assert.match(tsx, /visibility,\s*\n\s*linkedEventKitItemId: stockType === "event_kit" \? linkKitItemId : null,\s*\n\s*\}\);/);
});

test('painel admin da loja continua enxergando itens de QUALQUER visibilidade (nunca usa list_store_items_for_event, que agora e so-publico)', async () => {
  const tsx = await readFile(lojaPageUrl, 'utf8');
  assert.doesNotMatch(tsx, /supabase\.rpc\("list_store_items_for_event"/);
  assert.match(tsx, /select\(\s*\n\s*"id, event_id, name, slug, description, price, discount_type, discount_value, requires_variant, supply_mode, visibility, is_active, sort_order/);
});

// PARTE B -- concessao manual pelo admin
test('3. admin_grant_store_item existe, exige permissao store.manage, e busca o item sem filtrar por visibility (admin pode conceder qualquer modo)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_grant_store_item');
  assert.match(fn, /current_user_has_permission\('store\.manage'\)/);
  const whereClause = fn.match(/select \* into v_store_item from public\.store_items where id = p_store_item_id[\s\S]*?;/)?.[0] ?? '';
  assert.doesNotMatch(whereClause, /visibility/);
});

test('4/12/13. admin_grant_store_item nunca insere em tickets/participant_kit_items/tickets checkin -- so cria store_orders + store_order_items', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_grant_store_item');
  assert.doesNotMatch(fn, /insert into public\.tickets/);
  assert.doesNotMatch(fn, /insert into public\.participant_kit_items/);
  assert.doesNotMatch(fn, /update public\.tickets set status/);
  assert.match(fn, /insert into public\.store_orders/);
  assert.match(fn, /insert into public\.store_order_items/);
});

test('5. item adicional fica em store_order_items, ligado por store_orders.participant_id -- nunca em participant_kit_items (kit principal)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_grant_store_item');
  assert.match(fn, /v_participant_id := coalesce\(v_oi\.participant_id, v_ticket\.participant_id\);/);
  assert.match(fn, /insert into public\.store_orders \(organization_id, event_id, user_id, participant_id,/);
});

test('6. variante/tamanho correto e persistido em store_order_items.variant_id', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_grant_store_item');
  assert.match(fn, /insert into public\.store_order_items \(store_order_id, store_item_id, variant_id, quantity, unit_price, final_amount, status\)\s*\n\s*values \(v_order_id, v_store_item\.id, p_variant_id,/);
});

test('9. cortesia: final_amount=0 no pedido e no item, status confirmed/paid imediatamente (nunca gera cobranca)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_grant_store_item');
  assert.match(fn, /v_line_total := case when coalesce\(p_is_courtesy, false\) then 0 else round\(v_unit_price \* p_quantity, 2\) end;/);
  assert.match(fn, /case when coalesce\(p_is_courtesy, false\) then 'confirmed' else 'reserved' end\)\s*\n\s*returning id into v_item_id;/);
});

test('cobrar: reutiliza preco normal do item/variante e o fluxo financeiro JA existente (confirm_store_order_payment) -- nao cria sistema financeiro paralelo', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_grant_store_item');
  assert.match(fn, /v_unit_price := v_store_item\.price;/);
  assert.match(fn, /v_unit_price := v_unit_price \+ coalesce\(v_variant\.price_adjustment, 0\);/);
  // Nao redefine nem cria nenhuma RPC financeira nova -- so referencia (em
  // comentario) o fluxo ja existente de confirm_store_order_payment.
  assert.doesNotMatch(sql, /create (or replace )?function public\.\w*payment\w*/i);
});

test('estoque respeitado na concessao: admin_only nao significa estoque ilimitado -- mesma checagem de create_store_order (so quando supply_mode=stock)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_grant_store_item');
  assert.match(fn, /if v_store_item\.supply_mode = 'stock' then/);
  assert.match(fn, /raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK'/);
});

// 7/8 -- estoque baixa/bloqueia na entrega
test('7. deliver_store_order_item baixa estoque (reserved->delivered) do produto adicional na entrega', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_store_order_item');
  assert.match(fn, /reserved_quantity = greatest\(reserved_quantity - v_line\.quantity, 0\),\s*\n\s*delivered_quantity = delivered_quantity \+ v_line\.quantity/);
});

test('8. estoque 0/insuficiente SEMPRE bloqueia a entrega -- guarda nova antes de decrementar, mesmo padrao de erro estruturado do resto do sistema', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_store_order_item');
  assert.match(fn, /v_available := case when found then greatest\(v_inv\.total_quantity - v_inv\.delivered_quantity, 0\) else 0 end;/);
  assert.match(fn, /if v_inv\.id is null or v_available < v_line\.quantity then\s*\n\s*raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK'/);
});

test('12/13. entrega do adicional nunca toca tickets (check-in) nem participant_kit_items (kit principal)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_store_order_item');
  assert.doesNotMatch(fn, /public\.tickets|public\.participant_kit_items|public\.event_kit_item/);
});

// 14 -- auditoria
test('14. concessao registra quem/quando/participante/produto/variante/quantidade/cortesia-ou-pago/origem em audit_logs', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_grant_store_item');
  assert.match(fn, /insert into public\.audit_logs \(action, entity_type, entity_id, event_id, details\)\s*\n\s*values \('store_item_admin_granted'/);
  assert.match(fn, /'actor_user_id', v_actor, 'actor_email', v_actor_email, 'ticket_id', v_ticket\.id, 'participant_id', v_participant_id,/);
  assert.match(fn, /'variant_id', p_variant_id, 'quantity', p_quantity, 'is_courtesy', coalesce\(p_is_courtesy, false\)/);
  assert.match(fn, /'origin', 'admin', 'reason',/);
});

test('entrega tambem registra em audit_logs (padrao ja existente store_order_item_delivered)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_store_order_item');
  assert.match(fn, /insert into public\.audit_logs \(action, entity_type, entity_id, event_id, details\)\s*\n\s*values \('store_order_item_delivered'/);
});

// Central de Operacoes
test('Central: OperationTicketDetails ganha additional_items, e Central busca por store_orders.participant_id (nunca somado ao kit principal)', async () => {
  const types = await readFile(operacoesTypesUrl, 'utf8');
  assert.match(types, /additional_items: AdditionalItem\[\];/);
  const actions = await readFile(operacoesActionsUrl, 'utf8');
  assert.match(actions, /\.eq\("store_orders\.participant_id", participantId\)/);
  assert.match(actions, /additional_items: additionalItems,/);
});

test('Central: secao "Itens adicionais" separada da secao "Itens" (kit) -- nunca somada como unidades do mesmo beneficio', async () => {
  const tsx = await readFile(expandedTicketDetailsUrl, 'utf8');
  const kitSectionIndex = tsx.indexOf('<h3 className="text-sm font-semibold">Itens</h3>');
  const additionalSectionIndex = tsx.indexOf('Itens adicionais');
  assert.notEqual(kitSectionIndex, -1);
  assert.notEqual(additionalSectionIndex, -1);
  assert.ok(additionalSectionIndex > kitSectionIndex, 'secao de itens adicionais deveria vir depois, como bloco proprio');
  assert.match(tsx, /Produtos da loja concedidos ou comprados separadamente — nunca fazem parte do kit do ingresso\./);
});

test('Central mostra produto, variante, quantidade, status e origem por item adicional, com acao de entrega quando pendente', async () => {
  const tsx = await readFile(expandedTicketDetailsUrl, 'utf8');
  assert.match(tsx, /item\.store_item_name/);
  assert.match(tsx, /item\.variant_label/);
  assert.match(tsx, /x\{item\.quantity\}/);
  assert.match(tsx, /item\.status === "delivered" \? "Entregue" : item\.status === "confirmed" \? "Pendente" : "Aguardando pagamento"/);
  assert.match(tsx, /item\.origin === "admin" \? "Administrativo" : item\.origin === "codigo" \? "Código" : "Loja"/);
  assert.match(tsx, /onClick=\{\(\) => \{\s*\n\s*setAdditionalItemMessage\(null\);\s*\n\s*void onDeliverAdditionalItem\(item\.id\)/);
});

test('"Adicionar item" so aparece para quem tem canGrantStoreItems, e abre o GrantStoreItemModal', async () => {
  const tsx = await readFile(expandedTicketDetailsUrl, 'utf8');
  assert.match(tsx, /capabilities\.canGrantStoreItems \? \(/);
  assert.match(tsx, /setShowGrantStoreItem\(true\)/);
  assert.match(tsx, /<GrantStoreItemModal/);
});

test('GrantStoreItemModal: fluxo produto -> variante -> quantidade -> cortesia\\/cobrar', async () => {
  const tsx = await readFile(grantModalUrl, 'utf8');
  assert.match(tsx, /getGrantableStoreItemsAction/);
  assert.match(tsx, /Cortesia — sem cobrança/);
  assert.match(tsx, /Cobrar — preço normal do produto/);
  assert.match(tsx, /disabled=\{submitting \|\| loading \|\| items\.length === 0 \|\| outOfStock\}/);
});

// Permissoes
test('9 (permissoes). concessao especifica e entrega validadas no BACKEND, nao so escondendo o botao', async () => {
  const actions = await readFile(operacoesActionsUrl, 'utf8');
  assert.match(actions, /export async function getGrantableStoreItemsAction[\s\S]*?await assertStoreGrantPermission\(\);/);
  assert.match(actions, /export async function grantStoreItemAction\([\s\S]{0,300}?\{\s*\n\s*await assertStoreGrantPermission\(\);/);
  assert.match(actions, /hasPermission\("store\.grant_items"\)/);
  assert.match(actions, /assertPermission\("store\.manage"\)/);
  assert.match(actions, /export async function deliverAdditionalStoreItemAction[\s\S]{0,80}await assertPermission\("store\.deliver"\);/);
  const migrationSql = await readFile(migrationUrl, 'utf8');
  const grantFn = extractFunction(migrationSql, 'admin_grant_store_item');
  assert.match(grantFn, /if v_actor is null or not public\.current_user_has_permission\('store\.manage'\) then raise exception/);
});

// PART C -- code_required
test('15. code_required: implementado como valor valido da coluna, mas fluxo de codigo NAO construido -- documentado explicitamente, sem gambiarra em cupons', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /'code_required'/);
  assert.match(sql, /NOTA -- CODE_REQUIRED \(Parte C\)/);
  assert.match(sql, /o fluxo de liberacao por codigo NAO foi construido nesta migration/);
  // Nenhuma tabela/RPC de codigo de acesso foi de fato CRIADA -- so citadas
  // como recomendacao em comentario pra quando a Parte C for priorizada.
  assert.doesNotMatch(sql, /create table (if not exists )?public\.store_item_access_codes/);
  assert.doesNotMatch(sql, /create (or replace )?function public\.redeem_store_item_access_code/);
});

test('code_required se comporta como admin_only ate o fluxo de codigo existir (nao aparece, nao compravel self-service)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = sql.match(/create function public\.list_store_items_for_event[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.match(fn, /visibility = 'public'/);
  assert.doesNotMatch(fn, /code_required/);
});

// Confirma no baseline que store_orders.participant_id ja existia (reaproveitado, nao criado nesta tarefa)
test('StoreItemCard mostra um badge de visibilidade e repassa visibility pro StoreItemForm ao editar', async () => {
  const tsx = await readFile(storeItemCardUrl, 'utf8');
  assert.match(tsx, /VISIBILITY_BADGE\[item\.visibility\]/);
  assert.match(tsx, /visibility: item\.visibility,/);
});

test('upsertStoreItemAction (frontend) repassa p_visibility pra RPC upsert_store_item', async () => {
  const ts = await readFile(lojaActionsUrl, 'utf8');
  assert.match(ts, /visibility: "public" \| "code_required" \| "admin_only";/);
  assert.match(ts, /p_visibility: input\.visibility,/);
});

test('confirma que store_orders.participant_id ja existia no schema (coluna reaproveitada, nao criada por esta tarefa)', async () => {
  const sql = await readFile(baselineSchemaUrl, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "public"\."store_orders"/);
  const tableBlock = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS "public"."store_orders"'), sql.indexOf('CREATE TABLE IF NOT EXISTS "public"."store_orders"') + 1200);
  assert.match(tableBlock, /"participant_id" "uuid"/);
});

test('a migration da camiseta principal (52) permanece intocada -- confirma que nenhum arquivo desta tarefa a redefine', async () => {
  const migrationSql = await readFile(migrationUrl, 'utf8');
  assert.doesNotMatch(migrationSql, /20260852000000/);
});
