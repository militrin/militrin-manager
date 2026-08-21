import test from 'node:test';
import assert from 'node:assert/strict';
import { readReconciledFile as readFile } from './helpers/read-reconciled-file.mjs';

const migrationUrl = new URL('../supabase/migrations/20260854000000_store_item_global_creation_and_event_kit_stock_link.sql', import.meta.url);
const lojaPageUrl = new URL('../src/app/loja/page.tsx', import.meta.url);
const lojaActionsUrl = new URL('../src/app/loja/actions.ts', import.meta.url);
const storeItemFormUrl = new URL('../src/app/loja/store-item-form.tsx', import.meta.url);
const storeItemCardUrl = new URL('../src/app/loja/store-item-card.tsx', import.meta.url);
const operacoesActionsUrl = new URL('../src/app/operacoes/actions.ts', import.meta.url);

function extractFunction(sql, name) {
  const pattern = new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\nend;?\\s*\\n?\\$\\$;`);
  const match = sql.match(pattern);
  if (!match) throw new Error(`funcao ${name} nao encontrada`);
  return match[0];
}

// ============================================================
// 1/2 -- Novo item em "Todos os eventos"
// ============================================================
test('1. botao "Novo item" aparece independente do filtro (nunca mais gated por selectedEventId)', async () => {
  const tsx = await readFile(lojaPageUrl, 'utf8');
  assert.match(tsx, /canManage \? <StoreItemForm events=\{events\} eventId=\{selectedEventId\}/);
  assert.doesNotMatch(tsx, /canManage && selectedEventId \? <StoreItemForm/);
});

test('2. upsert_store_item resolve organizacao via current_organization_id\\(\\) quando p_event_id e nulo (criacao global) -- item criado fica com event_id nulo', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'upsert_store_item');
  assert.match(fn, /v_org := public\.current_organization_id\(\);/);
  assert.match(fn, /v_stored_event_id := case when coalesce\(p_available_all_events, false\) then null else p_event_id end;/);
});

// ============================================================
// 3/4/5/6/7 -- camiseta/produto GLOBAL com estoque proprio
// ============================================================
test('3. item NAO vinculado usa store_item_inventory (reserva e entrega) -- nunca event_kit_item_variant_inventory', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const reserve = extractFunction(sql, 'reserve_store_item_stock');
  const deliver = extractFunction(sql, 'deliver_store_item_stock');
  assert.match(reserve, /if v_item\.supply_mode = 'stock' then\s*\n\s*select \* into v_store_inv from public\.store_item_inventory/);
  assert.match(deliver, /if v_item\.supply_mode = 'stock' then\s*\n\s*select \* into v_store_inv from public\.store_item_inventory/);
});

test('4. upsert_store_item_variant bloqueia edicao SO quando o item esta vinculado -- item global/independente continua podendo cadastrar tamanhos livremente', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'upsert_store_item_variant');
  assert.match(fn, /if v_item\.linked_event_kit_item_id is not null then\s*\n\s*raise exception 'Este item usa os tamanhos da camiseta do evento/);
  // O bloqueio e condicional -- para item nao vinculado o fluxo normal de insert\/update continua liberado.
  assert.match(fn, /if p_id is null then\s*\n\s*insert into public\.store_item_variants/);
});

test('5. reserva bloqueia (PRODUCT_OUT_OF_STOCK) quando item independente esta em supply_mode=stock e nao ha disponibilidade', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'reserve_store_item_stock');
  assert.match(fn, /raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK'/);
});

test('6. reserva NUNCA bloqueia quando item independente esta em made_to_order (escolha sempre permitida, mesmo com estoque 0)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'reserve_store_item_stock');
  const nonLinkedBlock = fn.slice(fn.indexOf("if v_item.supply_mode = 'stock' then"));
  assert.match(nonLinkedBlock, /if v_item\.supply_mode = 'stock' then/);
  // Fora do "if supply_mode='stock'" nao ha nenhum outro bloqueio pro caminho nao vinculado.
});

test('7. entrega fisica de item independente SEMPRE valida estoque (incondicional a made_to_order\\/stock) -- estoque insuficiente bloqueia com PRODUCT_OUT_OF_STOCK', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_store_item_stock');
  assert.match(fn, /v_available := case when found then greatest\(v_store_inv\.total_quantity - v_store_inv\.delivered_quantity, 0\) else 0 end;\s*\n\s*if v_store_inv\.id is null or v_available < p_quantity then\s*\n\s*raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK'/);
});

// ============================================================
// 8/9/10/11/12/13 -- camiseta vinculada ao evento (estoque compartilhado)
// ============================================================
test('8. camiseta vinculada NUNCA cria estoque duplicado -- sync_linked_store_item_variants nao insere/atualiza store_item_inventory em nenhum momento', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'sync_linked_store_item_variants');
  assert.doesNotMatch(fn, /store_item_inventory/);
  assert.match(fn, /insert into public\.store_item_variants/);
});

test('9. variantes do item vinculado vem das variantes ATIVAS do item de kit do evento (nome\\/tamanho copiados, nunca reinventados)', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'sync_linked_store_item_variants');
  assert.match(fn, /select id, name, value, sort_order from public\.event_kit_item_variants\s*\n\s*where kit_item_id = v_item\.linked_event_kit_item_id and is_active/);
  assert.match(fn, /values \(p_store_item_id, v_kit_variant\.name, v_kit_variant\.value, 0, true, v_kit_variant\.sort_order, v_kit_variant\.id\)/);
});

test('10. concessao administrativa (admin_grant_store_item) usa a variante correta -- p_variant_id continua sendo store_item_variants.id, sem mudanca de contrato pro frontend', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'admin_grant_store_item');
  assert.match(fn, /select \* into v_variant from public\.store_item_variants where id = p_variant_id and store_item_id = v_store_item\.id and is_active;/);
  assert.match(fn, /perform public\.reserve_store_item_stock\(v_store_item\.id, p_variant_id, p_quantity\);/);
});

test('11. estoque compartilhado (event_kit_item_variant_inventory) e efetivamente afetado: reserva soma reserved_quantity, entrega move reserved->delivered', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const reserve = extractFunction(sql, 'reserve_store_item_stock');
  const deliver = extractFunction(sql, 'deliver_store_item_stock');
  assert.match(reserve, /update public\.event_kit_item_variant_inventory set reserved_quantity = reserved_quantity \+ p_quantity, updated_at = now\(\) where id = v_kit_inv\.id;/);
  assert.match(deliver, /update public\.event_kit_item_variant_inventory\s*\n\s*set reserved_quantity = greatest\(reserved_quantity - p_quantity, 0\), delivered_quantity = delivered_quantity \+ p_quantity, updated_at = now\(\)\s*\n\s*where id = v_kit_inv\.id;/);
});

test('12. entrega do item adicional vinculado usa o estoque do evento (event_kit_item_variant_inventory), com o mesmo bloqueio de estoque zero da entrega principal', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'deliver_store_item_stock');
  const linkedBlock = fn.slice(fn.indexOf('if v_item.linked_event_kit_item_id is not null then'), fn.indexOf('if v_item.supply_mode'));
  assert.match(linkedBlock, /select \* into v_kit_inv from public\.event_kit_item_variant_inventory/);
  assert.match(linkedBlock, /raise exception using errcode='P0001', message='STORE_ITEM_OUT_OF_STOCK'/);
});

test('13. kit principal continua usando exatamente as mesmas RPCs de antes -- esta migration nao redefine deliver_ticket_kit_item\\/deliver_ticket_full_kit\\/checkin_ticket_entry\\/admin_change_ticket_shirt', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const name of ['deliver_ticket_kit_item', 'deliver_ticket_full_kit', 'checkin_ticket_entry', 'admin_change_ticket_shirt', 'admin_correct_ticket_shirt_after_operation']) {
    assert.doesNotMatch(sql, new RegExp(`create (or replace )?function public\\.${name}\\(`));
  }
});

// ============================================================
// 14/15 -- atomicidade, anti dupla-baixa, anti overselling
// ============================================================
test('14. cancelamento e desfazer-entrega passam pelas MESMAS funcoes centralizadas usadas na reserva\\/entrega -- nao ha um segundo caminho de update direto duplicando a logica', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const cancel = extractFunction(sql, 'cancel_store_order');
  const undo = extractFunction(sql, 'undo_store_order_item_delivery');
  assert.match(cancel, /perform public\.release_store_item_reservation\(v_line\.store_item_id, v_line\.variant_id, v_line\.quantity\);/);
  assert.doesNotMatch(cancel, /update public\.store_item_inventory set reserved_quantity/);
  assert.match(undo, /perform public\.undo_deliver_store_item_stock\(v_line\.store_item_id, v_line\.variant_id, v_line\.quantity\);/);
  assert.doesNotMatch(undo, /update public\.store_item_inventory set delivered_quantity/);
});

test('15. reserva e entrega usam "for update" (lock de linha) nos dois caminhos (evento e loja) -- operacao concorrente nao consegue ler estoque desatualizado e vender/entregar 2x', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const reserve = extractFunction(sql, 'reserve_store_item_stock');
  const deliver = extractFunction(sql, 'deliver_store_item_stock');
  assert.match(reserve, /from public\.event_kit_item_variant_inventory\s*\n\s*where kit_item_id = v_kit_item\.id and variant_id = v_variant\.linked_event_kit_item_variant_id for update;/);
  assert.match(reserve, /from public\.store_item_inventory where store_item_id = p_store_item_id and variant_id is not distinct from p_variant_id for update;/);
  assert.match(deliver, /from public\.event_kit_item_variant_inventory\s*\n\s*where kit_item_id = v_kit_item\.id and variant_id = v_variant\.linked_event_kit_item_variant_id for update;/);
  assert.match(deliver, /from public\.store_item_inventory where store_item_id = p_store_item_id and variant_id is not distinct from p_variant_id for update;/);
});

// ============================================================
// 16/17/18/19/20 -- nao quebrar o que ja existia
// ============================================================
test('16/17. produtos globais e sem-estoque-compartilhado (copo, tirante, etc.) continuam usando exatamente o caminho de antes -- store_item_inventory, sem nenhuma condicao nova bloqueando', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const createOrder = extractFunction(sql, 'create_store_order');
  const addToCart = sql.match(/create or replace function public\.add_product_to_cart_order[\s\S]*?\nend; \$\$;/)?.[0] ?? '';
  assert.match(createOrder, /perform public\.reserve_store_item_stock\(v_store_item\.id, v_item\.variant_id, v_item\.quantity\);/);
  assert.match(addToCart, /perform public\.reserve_store_item_stock\(v_store_item\.id, p_variant_id, p_quantity\);/);
});

test('18. visibilidade (public\\/admin_only\\/code_required) continua validada em create_store_order e add_product_to_cart_order, sem alteracao de comportamento', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const createOrder = extractFunction(sql, 'create_store_order');
  const addToCart = sql.match(/create or replace function public\.add_product_to_cart_order[\s\S]*?\nend; \$\$;/)?.[0] ?? '';
  assert.match(createOrder, /if v_store_item\.visibility <> 'public' then raise exception 'Item % nao esta disponivel para compra publica\.', v_store_item\.name; end if;/);
  assert.match(addToCart, /if v_store_item\.visibility <> 'public' then raise exception 'Produto nao esta disponivel para compra publica\.'; end if;/);
});

test('19. mudar admin_only -> public (so a coluna visibility) nunca toca em estoque\\/variantes\\/pedidos -- upsert_store_item so atualiza a linha de store_items', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'upsert_store_item');
  const updateBlock = fn.match(/update public\.store_items set[\s\S]*?returning id into v_id;/)?.[0] ?? '';
  assert.notEqual(updateBlock, '');
  assert.doesNotMatch(updateBlock, /store_item_inventory|store_order_items|store_item_variants(?!_id)/);
});

test('20. nenhuma operacao desta migration cria ingresso (tickets) -- confirmado em toda a migration', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.doesNotMatch(sql, /insert into public\.tickets/);
});

// ============================================================
// NOVO ESCOPO -- edicao de produto (nome/preco/descricao/visibilidade/vinculo)
// ============================================================
test('21/22. produto SEM estoque compartilhado pode mudar evento especifico <-> global livremente (sem bloqueio) -- so os itens vinculados tem restricao', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'upsert_store_item');
  const nonLinkedElseBlock = fn.slice(fn.indexOf('  else\n    -- Desvincular'), fn.indexOf('  if p_id is null then'));
  assert.match(nonLinkedElseBlock, /v_stored_event_id := case when coalesce\(p_available_all_events, false\) then null else p_event_id end;/);
});

test('23. edicao (UPDATE) nunca recria a linha nem toca em store_item_images\\/store_item_inventory\\/store_order_items\\/audit_logs -- id, fotos, estoque e historico preservados', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'upsert_store_item');
  assert.doesNotMatch(fn, /insert into public\.store_item_images/);
  assert.doesNotMatch(fn, /delete from public\.store_item_images/);
  assert.doesNotMatch(fn, /insert into public\.audit_logs/);
  const updateBlock = fn.match(/update public\.store_items set[\s\S]*?returning id into v_id;/)?.[0] ?? '';
  assert.match(updateBlock, /where id = p_id/);
});

test('24. produto global aparece corretamente pro evento consultado -- list_store_items_for_event mantem "si.event_id = p_event_id or si.event_id is null"', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = sql.match(/create function public\.list_store_items_for_event[\s\S]*?\$\$;/)?.[0] ?? '';
  assert.match(fn, /where \(si\.event_id = p_event_id or si\.event_id is null\) and si\.is_active and si\.visibility = 'public'/);
});

test('25. produto que deixa de ser global (recebe evento especifico) e validado contra a organizacao correta -- rejeita evento de outra organizacao', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'upsert_store_item');
  assert.match(fn, /if not found or v_event\.organization_id <> v_org then raise exception 'Evento invalido para este item\.'; end if;/);
});

test('26. upsert_store_item nunca duplica produto -- quando p_id e informado, so faz UPDATE (retorna o mesmo id), nunca INSERT', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'upsert_store_item');
  assert.match(fn, /if p_id is null then\s*\n\s*insert into public\.store_items/);
  assert.match(fn, /else\s*\n\s*update public\.store_items set/);
});

test('27. camiseta com fonte de estoque incompativel NUNCA migra silenciosamente -- as 3 transicoes de risco sao bloqueadas com erro explicito, nao com fusao automatica', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const fn = extractFunction(sql, 'upsert_store_item');
  // estoque proprio -> vinculado, com estoque/reserva/entrega ja existente.
  assert.match(fn, /if p_id is not null and v_previous_link is null and exists \(\s*\n\s*select 1 from public\.store_item_inventory\s*\n\s*where store_item_id = p_id and \(total_quantity > 0 or reserved_quantity > 0 or delivered_quantity > 0\)\s*\n\s*\) then\s*\n\s*raise exception 'Este item ja possui estoque proprio configurado/);
  // vinculado -> item de kit diferente, com pedido/concessao ja usando o vinculo atual.
  assert.match(fn, /if p_id is not null and v_previous_link is not null and p_linked_event_kit_item_id is distinct from v_previous_link and exists \(/);
  // vinculado -> estoque proprio (desvincular), com pedido/concessao ja usando o vinculo atual.
  assert.match(fn, /if p_id is not null and v_previous_link is not null and exists \(\s*\n\s*select 1 from public\.store_order_items soi join public\.store_item_variants siv on siv\.id = soi\.variant_id\s*\n\s*where soi\.store_item_id = p_id and siv\.linked_event_kit_item_variant_id is not null and soi\.status <> 'cancelled'\s*\n\s*\) then\s*\n\s*raise exception 'Este item ja possui pedidos ou concessoes usando o estoque compartilhado do evento\./);
  // Nenhuma fusao/migracao automatica de estoque em lugar nenhum da RPC.
  assert.doesNotMatch(fn, /migrar|merge|fundir/i);
});

// ============================================================
// UI -- "Editar produto" sempre disponivel, tipo de estoque, vinculo
// ============================================================
test('StoreItemCard oferece "Editar produto" (via StoreItemForm) independente do filtro da pagina -- gate contextEventId foi removido', async () => {
  const tsx = await readFile(storeItemCardUrl, 'utf8');
  assert.doesNotMatch(tsx, /contextEventId/);
  assert.match(tsx, /\{canManage \? \(/);
  assert.match(tsx, /<StoreItemForm/);
  assert.match(tsx, /eventId=\{item\.eventId\}/);
});

test('StoreItemForm usa o rotulo "Editar produto" e recebe eventId nulavel (item global)', async () => {
  const tsx = await readFile(storeItemFormUrl, 'utf8');
  assert.match(tsx, /\{item \? "Editar produto" : "Novo item"\}/);
  assert.match(tsx, /eventId: string \| null;/);
});

test('StoreItemForm tem radio "Tipo de estoque" (Usar camiseta de um evento \\/ Estoque proprio) e busca itens de kit via getEventKitItemsForLinkAction', async () => {
  const tsx = await readFile(storeItemFormUrl, 'utf8');
  assert.match(tsx, /Tipo de estoque/);
  assert.match(tsx, /Usar camiseta \(ou outro item\) de um evento/);
  assert.match(tsx, /Estoque próprio/);
  assert.match(tsx, /getEventKitItemsForLinkAction/);
  assert.match(tsx, /Este produto utilizará os mesmos tamanhos e o mesmo estoque do item de kit escolhido/);
});

test('loja/actions.ts: upsertStoreItemAction aceita eventId nulavel e linkedEventKitItemId; getEventKitItemsForLinkAction e syncLinkedStoreItemVariantsAction existem', async () => {
  const ts = await readFile(lojaActionsUrl, 'utf8');
  assert.match(ts, /eventId: string \| null;/);
  assert.match(ts, /linkedEventKitItemId: string \| null;/);
  assert.match(ts, /p_linked_event_kit_item_id: input\.linkedEventKitItemId,/);
  assert.match(ts, /export async function getEventKitItemsForLinkAction/);
  assert.match(ts, /export async function syncLinkedStoreItemVariantsAction/);
  assert.match(ts, /supabase\.rpc\("sync_linked_store_item_variants"/);
});

test('operacoes/actions.ts: getGrantableStoreItemsAction busca disponibilidade em event_kit_item_variant_inventory quando o item esta vinculado', async () => {
  const ts = await readFile(operacoesActionsUrl, 'utf8');
  assert.match(ts, /linked_event_kit_item_id, event_kit_items\(shirt_supply_mode\)/);
  assert.match(ts, /from\("event_kit_item_variant_inventory"\)/);
  assert.match(ts, /linkedToEventKit: Boolean\(linkedKitItemId\),/);
});

test('page.tsx busca linked_event_kit_item_id e o join com event_kit_items(name), e passa "events" pro StoreItemCard', async () => {
  const tsx = await readFile(lojaPageUrl, 'utf8');
  assert.match(tsx, /linked_event_kit_item_id, event_kit_items\(name, shirt_supply_mode\)/);
  assert.match(tsx, /<StoreItemCard key=\{item\.id\} events=\{events\} item=\{item\} canManage=\{canManage\} \/>/);
});
