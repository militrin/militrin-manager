-- UX: acesso ao QR Code de CADA produto "compre junto" comprado dentro do
-- pedido de ingresso (Etapa "Concluido" do checkout de /inscricao), nao so
-- do ingresso.
--
-- INVESTIGACAO (resumo -- ver relatorio completo dado ao usuario fora desta
-- migration): confirmado que store_order_items (loja standalone, /loja) e
-- order_items item_kind='product' (compre junto, dentro do MESMO pedido do
-- ingresso) sao dois dominios PARALELOS e desconectados por decisao de
-- projeto ja documentada em 20260825000000_order_items_product_lines.sql --
-- nao existe FK, RPC nem trigger que ligue os dois, e order_items nunca
-- ganhou qr_token (so store_order_items ganhou, em 20260860000000). Ou seja:
-- a rota de QR existente (/api/loja/pedidos/[storeOrderId]/itens/[itemId]/
-- qrcode) opera sobre uma tabela que os produtos "compre junto" nunca
-- tocam -- reutiliza-la literalmente e impossivel. Em vez de inventar uma
-- arquitetura nova, esta migration aplica o MESMO padrao ja usado por
-- store_order_items.qr_token (coluna opaca, unique, default gerado) a
-- order_items, e a rota nova (src/app/api/inscricao/pedidos/[orderId]/itens/
-- [itemId]/qrcode) espelha byte a byte a composicao SVG e a regra de
-- autorizacao ja confirmada (dono do pedido OU store.deliver OU
-- store.manage) da rota da loja.
begin;

-- ============================================================
-- 1) order_items.qr_token -- NULLABLE (ao contrario de store_order_items,
--    esta tabela tambem guarda linhas de INGRESSO, que usam tickets.token
--    como QR canonico -- nunca geram qr_token aqui). Sem DEFAULT de coluna
--    (evitaria gerar token inutil em toda linha de ingresso a cada insert);
--    gerado explicitamente so pra item_kind='product', no INSERT de
--    add_product_to_cart_order (unico inserter de linha de produto --
--    confirmado por grep em toda a arvore de migrations).
-- ============================================================
alter table public.order_items
  add column if not exists qr_token text;

update public.order_items
  set qr_token = 'ITEM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  where item_kind = 'product' and qr_token is null;

create unique index if not exists order_items_qr_token_key on public.order_items (qr_token) where qr_token is not null;

comment on column public.order_items.qr_token is 'Token opaco por LINHA de produto "compre junto" (nunca por unidade -- quantity>1 na mesma linha usa o mesmo token, igual store_order_items). NULL para item_kind=''ticket'' (usa tickets.token). Gerado uma unica vez no INSERT de add_product_to_cart_order; nunca regenerado ao mudar quantidade.';

-- ============================================================
-- 2) add_product_to_cart_order -- redefinida a partir da versao VIGENTE
--    (20260912000000, confirmada por grep como a ultima). UNICA mudanca: o
--    INSERT de linha nova passa a gravar qr_token. O branch de consolidacao
--    (produto ja no carrinho, so soma quantidade) continua SEM tocar
--    qr_token -- a linha e a mesma, o token tem que continuar o mesmo.
-- ============================================================
create or replace function public.add_product_to_cart_order(p_order_id uuid, p_store_item_id uuid, p_variant_id uuid default null, p_quantity integer default 1)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_store_item public.store_items%rowtype;
  v_variant public.store_item_variants%rowtype;
  v_base_unit_price numeric; v_unit_price numeric; v_existing public.order_items%rowtype; v_item_id uuid; v_new_quantity integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantidade invalida.'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta mais no carrinho.'; end if;

  select * into v_store_item from public.store_items where id = p_store_item_id
    and (event_id = v_order.event_id or event_id is null) and is_active and organization_id = v_order.organization_id;
  if not found then raise exception 'Produto indisponivel para este pedido.'; end if;
  if v_store_item.visibility <> 'public' then raise exception 'Produto nao esta disponivel para compra publica.'; end if;
  if v_store_item.requires_variant and p_variant_id is null then raise exception 'Produto exige selecao de variante.'; end if;

  v_base_unit_price := v_store_item.price;
  if p_variant_id is not null then
    select * into v_variant from public.store_item_variants where id = p_variant_id and store_item_id = v_store_item.id and is_active;
    if not found then raise exception 'Variante invalida para o produto.'; end if;
    v_base_unit_price := v_base_unit_price + coalesce(v_variant.price_adjustment, 0);
  end if;
  v_unit_price := public.compute_store_item_final_price(v_base_unit_price, v_store_item.discount_type, v_store_item.discount_value);

  select * into v_existing from public.order_items where order_id = p_order_id and item_kind = 'product'
    and store_item_id = v_store_item.id and store_item_variant_id is not distinct from p_variant_id
    and status not in ('cancelled','expired','refunded','transferred') for update;

  perform public.reserve_store_item_stock(v_store_item.id, p_variant_id, p_quantity);

  if found and v_existing.id is not null then
    v_new_quantity := v_existing.quantity + p_quantity;
    update public.order_items
      set quantity = v_new_quantity, unit_price = v_unit_price, product_base_unit_price = v_base_unit_price,
        final_amount = round(v_unit_price * v_new_quantity, 2), updated_at = now()
      where id = v_existing.id
      returning id into v_item_id;
  else
    insert into public.order_items(order_id, event_id, item_kind, store_item_id, store_item_variant_id, quantity, unit_price, product_base_unit_price, discount_amount, final_amount, status, ownership_status, qr_token)
    values(p_order_id, v_order.event_id, 'product', v_store_item.id, p_variant_id, p_quantity, v_unit_price, v_base_unit_price, 0, round(v_unit_price * p_quantity, 2), 'reserved', 'unassigned',
      'ITEM-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)))
    returning id into v_item_id;
  end if;

  perform public.apply_cart_coupon(p_order_id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_added', 'orders', p_order_id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'store_item_id', v_store_item.id, 'variant_id', p_variant_id, 'quantity_added', p_quantity, 'order_item_id', v_item_id, 'base_unit_price', v_base_unit_price, 'unit_price', v_unit_price));

  return jsonb_build_object('order_item_ids', array[v_item_id], 'unit_price', v_unit_price);
end; $$;

commit;
