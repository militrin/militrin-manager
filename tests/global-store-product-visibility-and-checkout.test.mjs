import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Bug: produto global da loja ("Todos os eventos", store_items.event_id
// null) nao aparecia em /minha-conta/loja pra um usuario sem nenhum ingresso
// e nao podia ser comprado, porque (1) a pagina fechava com o estado vazio
// "Nenhum evento disponivel" antes de consultar produtos quando
// ownedEventIds era vazio, e (2) mesmo corrigindo isso, store_orders.event_id
// era NOT NULL e create_store_order sempre exigia um evento valido -- um
// pedido 100% de produtos globais jamais poderia ser criado.

const migration = await readFile(new URL('../supabase/migrations/20260867000000_store_global_product_no_event_checkout.sql', import.meta.url), 'utf8');
const listStoreItemsRpc = await readFile(new URL('../supabase/migrations/20260855000000_store_item_lifecycle_and_discount_pricing.sql', import.meta.url), 'utf8');
const accountLojaPage = await readFile(new URL('../src/app/minha-conta/loja/page.tsx', import.meta.url), 'utf8');
const accountStoreShop = await readFile(new URL('../src/components/store/AccountStoreShop.tsx', import.meta.url), 'utf8');
const cartContext = await readFile(new URL('../src/lib/store/cart-context.tsx', import.meta.url), 'utf8');
const storeActions = await readFile(new URL('../src/lib/store/actions.ts', import.meta.url), 'utf8');
const getStoreItems = await readFile(new URL('../src/lib/store/get-store-items.ts', import.meta.url), 'utf8');
const operacoesActions = await readFile(new URL('../src/app/operacoes/actions.ts', import.meta.url), 'utf8');

test('list_store_items_for_event (catalogo): produto global aparece independente de evento, e so quando ativo/publico', () => {
  assert.match(listStoreItemsRpc, /where \(si\.event_id = p_event_id or si\.event_id is null\) and si\.is_active and si\.visibility = 'public'/);
});

test('list_store_items_for_event: estoque de produto global sem kit vinculado usa store_item_inventory proprio, nunca o do kit', () => {
  // O join com estoque do KIT so acontece quando linked_event_kit_item_id NAO e nulo;
  // produto global tipico nao tem kit vinculado, entao cai sempre no store_inv proprio.
  assert.match(listStoreItemsRpc, /left join public\.event_kit_item_variant_inventory kit_inv\s*\n\s*on si\.linked_event_kit_item_id is not null/);
  assert.match(listStoreItemsRpc, /left join public\.store_item_inventory store_inv\s*\n\s*on si\.linked_event_kit_item_id is null and store_inv\.store_item_id = si\.id/);
  assert.match(listStoreItemsRpc, /coalesce\(kit_inv\.total_quantity, store_inv\.total_quantity, 0\)/);
});

test('/minha-conta/loja: produto global e sempre carregado, mesmo sem nenhum evento acessivel (sem gate por ownedEventIds)', () => {
  // Regressao central do bug: a pagina NAO PODE mais fechar com estado vazio
  // de "sem evento" antes de consultar produtos globais.
  assert.doesNotMatch(accountLojaPage, /if \(events\.length === 0\)[\s\S]{0,120}return/);
  // getStoreItemsForEvent(supabase, null) e chamado incondicionalmente --
  // nunca dentro de um if que dependa de events.length.
  assert.match(accountLojaPage, /const globalItems = await getStoreItemsForEvent\(supabase, null\);/);
});

test('/minha-conta/loja: produto vinculado a evento so carrega quando ha evento acessivel/selecionado', () => {
  assert.match(accountLojaPage, /const eventItems = events\.length === 0\s*\n\s*\? \[\]/);
});

test('/minha-conta/loja: "Nenhum evento disponivel" nunca e mais o estado vazio da loja inteira -- so esconde a secao de evento', () => {
  assert.doesNotMatch(accountLojaPage, /Nenhum evento dispon[íi]vel/);
  assert.match(accountLojaPage, /events\.length > 0 \? \(/);
  assert.match(accountLojaPage, /Produtos para todos/);
  assert.match(accountLojaPage, /Produtos dos seus eventos/);
  // Estado vazio real (nenhum produto de nenhum tipo) usa mensagem generica.
  assert.match(accountLojaPage, /hasAnyItem[\s\S]{0,200}Nenhum item dispon[íi]vel/);
});

test('/minha-conta/loja: "Meus pedidos da loja" inclui pedidos de produto global (event_id null), nao so os do(s) evento(s) do usuario', () => {
  assert.match(accountLojaPage, /await ordersQuery\.or\(`event_id\.is\.null,event_id\.in\.\(\$\{events\.map/);
  assert.match(accountLojaPage, /await ordersQuery\.is\('event_id', null\)/);
});

test('AccountStoreShop: produto global nunca exige escolher evento -- so produto vinculado a evento especifico exige', () => {
  assert.match(accountStoreShop, /if \(events\.length === 0\) return null;/);
  assert.match(accountStoreShop, /if \(item\.eventId && !targetEventOption\)/);
  assert.doesNotMatch(accountStoreShop, /if \(!targetEventOption\) \{/);
  assert.match(accountStoreShop, /eventId: targetEventOption\?\.id \?\? null/);
});

test('carrinho: eventId aceita null em toda a cadeia (contexto, action, RPC)', () => {
  assert.match(cartContext, /eventId: string \| null/);
  assert.match(storeActions, /eventId: string \| null/);
  assert.match(storeActions, /p_event_id: input\.eventId/);
});

test('create_store_order (migration corretiva): aceita pedido sem evento, mas so quando 100% composto por produtos globais', () => {
  assert.match(migration, /alter table public\.store_orders\s*\n\s*alter column event_id drop not null;/);
  assert.match(migration, /if p_event_id is not null then/);
  assert.match(migration, /select \* into v_event from public\.events where id = p_event_id;/);
  // Sem evento: organization_id vem dos proprios itens, e so aceita item com event_id IS NULL (global).
  assert.match(migration, /select si\.organization_id into v_organization_id/);
  assert.match(migration, /where si\.event_id is null and si\.is_active/);
  assert.match(migration, /if v_organization_id is null then raise exception 'Nenhum item valido para pedido sem evento\.'; end if;/);
  assert.match(migration, /select \* into v_store_item from public\.store_items where id = v_item\.store_item_id and event_id is null and is_active and organization_id = v_organization_id;/);
  // Estoque proprio: reserve_store_item_stock e chamado igual em ambos os
  // ramos (com ou sem evento) -- nada muda no calculo/reserva de estoque.
  assert.match(migration, /perform public\.reserve_store_item_stock\(v_store_item\.id, v_item\.variant_id, v_item\.quantity\);/);
  const reserveCalls = migration.match(/perform public\.reserve_store_item_stock/g) ?? [];
  assert.equal(reserveCalls.length, 1, 'reserve_store_item_stock deve ser chamado no MESMO ponto do loop pros dois ramos, nao duplicado por ramo');
});

test('create_store_order: pedido sem evento nunca faz lookup de participante/ticket (nao exige ticket)', () => {
  const noEventBranch = migration.slice(migration.indexOf('else'), migration.indexOf('v_paid := lower'));
  assert.doesNotMatch(noEventBranch, /participants/);
  assert.match(migration, /v_participant_id := null;/);
});

test('trg_store_orders_set_org: nao explode mais com event_id null (mesmo padrao ja usado por trg_store_items_set_org)', () => {
  assert.match(migration, /if NEW\.event_id is not null then[\s\S]*?elsif NEW\.organization_id is null then\s*\n\s*raise exception 'organization_id obrigatorio para pedido sem evento \(produto global\)\.';/);
});

test('operacoes: tela de retirada/kit tambem enxerga item de produto global comprado pelo participante (nao so o do evento do ingresso)', () => {
  assert.match(operacoesActions, /\.or\(`event_id\.eq\.\$\{String\(ticketRow\.event_id \?\? ""\)\},event_id\.is\.null`, \{ referencedTable: "store_orders" \}\)/);
  assert.doesNotMatch(operacoesActions, /\.eq\("store_orders\.event_id", String\(ticketRow\.event_id \?\? ""\)\)/);
});

test('getStoreItemsForEvent aceita eventId null (produto global) sem precisar de uma segunda funcao paralela', () => {
  assert.match(getStoreItems, /eventId: string \| null/);
});
