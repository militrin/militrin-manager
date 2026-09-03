-- FEATURE (7/10): as 2 RPCs que mudam/removem uma linha de produto AINDA
-- NO CARRINHO (pedido status='pending', portanto nenhuma unidade pode ter
-- sido entregue ainda -- delivery so e possivel apos confirmacao de
-- pagamento) mantem order_item_pickup_units sincronizada:
--   1) set_cart_order_item_quantity -- linha per_unit re-sincroniza as
--      unidades pra bater com a nova quantidade via delete+re-insert
--      (sempre, pra qualquer quantidade >= 1 -- modelo unico, sem excecao).
--      Mais simples e seguro que tentar preservar numeracao pre-pagamento
--      (nenhum QR e exibido ao comprador antes da confirmacao do pedido).
--   2) remove_cart_order_item -- apaga as unidades junto com a linha.
begin;

create or replace function public.set_cart_order_item_quantity(p_order_item_id uuid, p_quantity integer)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_base_unit_price numeric; v_unit_price numeric; v_delta integer; v_i integer;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  if coalesce(p_quantity, 0) <= 0 then raise exception 'Quantidade invalida.'; end if;
  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Item nao encontrado.'; end if;
  if v_item.item_kind <> 'product' then raise exception 'Somente itens de produto tem quantidade ajustavel por aqui.'; end if;
  select * into v_order from public.orders where id = v_item.order_id for update;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta mais no carrinho.'; end if;
  if v_item.status = 'cancelled' then raise exception 'Item ja foi removido do carrinho.'; end if;

  select * into v_store_item from public.store_items where id = v_item.store_item_id;
  if not found then raise exception 'Produto do item nao encontrado.'; end if;
  v_base_unit_price := v_store_item.price;
  if v_item.store_item_variant_id is not null then
    select * into v_variant from public.store_item_variants where id = v_item.store_item_variant_id;
    if found then v_base_unit_price := v_base_unit_price + coalesce(v_variant.price_adjustment, 0); end if;
  end if;
  v_unit_price := public.compute_store_item_final_price(v_base_unit_price, v_store_item.discount_type, v_store_item.discount_value);

  v_delta := p_quantity - v_item.quantity;
  if v_delta > 0 then perform public.reserve_store_item_stock(v_item.store_item_id, v_item.store_item_variant_id, v_delta);
  elsif v_delta < 0 then perform public.release_store_item_reservation(v_item.store_item_id, v_item.store_item_variant_id, -v_delta); end if;

  update public.order_items
    set quantity = p_quantity, unit_price = v_unit_price, product_base_unit_price = v_base_unit_price,
      final_amount = round(v_unit_price * p_quantity, 2), updated_at = now()
    where id = p_order_item_id;

  -- Pedido ainda esta em carrinho (pending) -- nenhuma unidade pode ter sido
  -- entregue ainda. Re-materializa do zero pra bater com a nova quantidade,
  -- SEMPRE (modelo unico: linha per_unit sempre tem exatamente `quantity`
  -- unidades, mesmo quantity=1).
  if coalesce(v_item.pickup_qr_mode, 'per_line') = 'per_unit' then
    delete from public.order_item_pickup_units where order_item_id = p_order_item_id;
    for v_i in 1..p_quantity loop
      insert into public.order_item_pickup_units(order_item_id, unit_index, qr_token, status)
      values (p_order_item_id, v_i, 'UNIT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)), 'reserved');
    end loop;
  end if;

  perform public.apply_cart_coupon(v_order.id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_quantity_changed', 'orders', v_order.id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'order_item_id', p_order_item_id, 'quantity', p_quantity, 'previous_quantity', v_item.quantity));

  return jsonb_build_object('order_id', v_order.id, 'order_item_id', p_order_item_id, 'quantity', p_quantity);
end; $$;

create or replace function public.remove_cart_order_item(p_order_item_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_item from public.order_items where id = p_order_item_id for update;
  if not found then raise exception 'Item nao encontrado.'; end if;
  if v_item.item_kind <> 'product' then raise exception 'Somente itens de produto podem ser removidos do carrinho por aqui.'; end if;
  select * into v_order from public.orders where id = v_item.order_id for update;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then raise exception 'Sem acesso a este pedido.'; end if;
  if v_order.status <> 'pending' then raise exception 'Pedido nao esta mais no carrinho.'; end if;
  if v_item.status = 'cancelled' then return jsonb_build_object('order_id', v_order.id, 'already_removed', true); end if;

  perform public.release_store_item_reservation(v_item.store_item_id, v_item.store_item_variant_id, v_item.quantity);

  update public.order_items set status = 'cancelled', discount_amount = 0, final_amount = 0, updated_at = now() where id = p_order_item_id;
  delete from public.order_item_discounts where order_item_id = p_order_item_id;
  delete from public.order_item_pickup_units where order_item_id = p_order_item_id;

  perform public.apply_cart_coupon(v_order.id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_removed', 'orders', v_order.id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'order_item_id', p_order_item_id));

  return jsonb_build_object('order_id', v_order.id, 'removed', true);
end; $$;

commit;
