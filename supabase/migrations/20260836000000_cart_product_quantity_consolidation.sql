-- Consolidacao de quantidade no "Compre junto".
--
-- order_items.quantity ja existia, mas add_product_to_cart_order nunca a
-- usava de verdade: pedia p_quantity e fazia um loop inserindo p_quantity
-- LINHAS separadas, cada uma com quantity=1 fixo. Resultado visivel: somar o
-- mesmo produto duas vezes criava "1x Produto" + "1x Produto" em vez de uma
-- linha "Produto · quantidade 2". Esta migration faz quantity valer pra
-- valer: 1 linha por identidade comercial (store_item_id + variante) por
-- pedido, quantity acumula, unit_price continua sendo o preco POR UNIDADE
-- (fonte de verdade sempre re-lida de store_items/store_item_variants,
-- nunca aceita do client) e discount_amount/final_amount da linha passam a
-- ser o total da linha (unit_price*quantity menos desconto), nao mais de 1
-- unidade isolada.
--
-- Nada disso toca item_kind='ticket': cada ingresso continua sua propria
-- linha com quantity=1 (titular/holder e uma identidade por linha, nunca
-- consolidavel). apply_cart_coupon passa a operar sobre unit_price*quantity
-- para qualquer item_kind, o que e um no-op para tickets (quantity=1 la)
-- e a correcao real para produtos.
begin;

-- ============================================================
-- 0. order_items_quantity_is_one_check vinha do schema original (so
--    ingresso existia, cada linha SEMPRE 1 pessoa/1 unidade) e travava
--    quantity=1 pra QUALQUER linha, ingresso ou produto -- e o motivo real
--    de add_product_to_cart_order ter sido escrito com um loop de insert em
--    vez de usar a coluna quantity de verdade. Ingresso continua exigindo
--    quantity=1 (titular e uma identidade por linha, nunca agregavel);
--    produto passa a aceitar quantity>=1.
-- ============================================================

alter table public.order_items drop constraint order_items_quantity_is_one_check;
alter table public.order_items add constraint order_items_quantity_check check (
  (item_kind = 'ticket' and quantity = 1) or (item_kind = 'product' and quantity >= 1)
);

-- ============================================================
-- 1. add_product_to_cart_order: consolida em vez de duplicar linha.
-- ============================================================

create or replace function public.add_product_to_cart_order(p_order_id uuid, p_store_item_id uuid, p_variant_id uuid default null, p_quantity integer default 1)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_store_item public.store_items%rowtype;
  v_variant public.store_item_variants%rowtype; v_inv public.store_item_inventory%rowtype;
  v_unit_price numeric; v_existing public.order_items%rowtype; v_item_id uuid; v_new_quantity integer;
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
  if v_store_item.requires_variant and p_variant_id is null then raise exception 'Produto exige selecao de variante.'; end if;

  v_unit_price := v_store_item.price;
  if p_variant_id is not null then
    select * into v_variant from public.store_item_variants where id = p_variant_id and store_item_id = v_store_item.id and is_active;
    if not found then raise exception 'Variante invalida para o produto.'; end if;
    v_unit_price := v_unit_price + coalesce(v_variant.price_adjustment, 0);
  end if;

  -- Linha comercial existente = mesmo produto + mesma variante (null-safe),
  -- ainda ativa no carrinho. Identidade de consolidacao explicitamente NAO
  -- inclui preco: se o preco mudou desde a ultima adicao, a linha inteira e
  -- re-precificada abaixo pelo valor atual (nunca fica com preco misto).
  select * into v_existing from public.order_items
    where order_id = p_order_id and item_kind = 'product' and store_item_id = v_store_item.id
      and store_item_variant_id is not distinct from p_variant_id
      and status not in ('cancelled','expired','refunded','transferred')
    for update;

  if v_store_item.supply_mode = 'stock' then
    select * into v_inv from public.store_item_inventory where store_item_id = v_store_item.id and variant_id is not distinct from p_variant_id for update;
    if not found or coalesce(v_inv.total_quantity,0) - coalesce(v_inv.reserved_quantity,0) - coalesce(v_inv.delivered_quantity,0) < p_quantity then
      raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK', detail=jsonb_build_object('code','PRODUCT_OUT_OF_STOCK','message',format('Estoque insuficiente para %s.', v_store_item.name))::text;
    end if;
    update public.store_item_inventory set reserved_quantity = reserved_quantity + p_quantity, updated_at = now() where id = v_inv.id;
  end if;

  if found and v_existing.id is not null then
    v_new_quantity := v_existing.quantity + p_quantity;
    update public.order_items
      set quantity = v_new_quantity, unit_price = v_unit_price, final_amount = round(v_unit_price * v_new_quantity, 2), updated_at = now()
      where id = v_existing.id
      returning id into v_item_id;
  else
    insert into public.order_items(order_id, event_id, item_kind, store_item_id, store_item_variant_id, quantity, unit_price, discount_amount, final_amount, status, ownership_status)
    values(p_order_id, v_order.event_id, 'product', v_store_item.id, p_variant_id, p_quantity, v_unit_price, 0, round(v_unit_price * p_quantity, 2), 'reserved', 'unassigned')
    returning id into v_item_id;
  end if;

  -- Recalcula (produto entrando/quantidade mudando pode mudar elegibilidade/desconto do cupom ja aplicado).
  perform public.apply_cart_coupon(p_order_id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_added', 'orders', p_order_id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'store_item_id', v_store_item.id, 'variant_id', p_variant_id, 'quantity_added', p_quantity, 'order_item_id', v_item_id));

  return jsonb_build_object('order_item_ids', array[v_item_id], 'unit_price', v_unit_price);
end; $$;

-- ============================================================
-- 2. set_cart_order_item_quantity: altera a quantidade de uma linha ja no
--    carrinho (botoes [-]/[+]). Quantidade minima aceita aqui e 1 -- chegar
--    a 0 e responsabilidade do client chamar remove_cart_order_item (mesmo
--    padrao ja usado hoje pra remover, sem introduzir um segundo caminho de
--    "remocao implicita" dentro desta RPC).
-- ============================================================

create or replace function public.set_cart_order_item_quantity(p_order_item_id uuid, p_quantity integer)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid(); v_item public.order_items%rowtype; v_order public.orders%rowtype;
  v_store_item public.store_items%rowtype; v_variant public.store_item_variants%rowtype;
  v_inv public.store_item_inventory%rowtype; v_unit_price numeric; v_delta integer;
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
  v_unit_price := v_store_item.price;
  if v_item.store_item_variant_id is not null then
    select * into v_variant from public.store_item_variants where id = v_item.store_item_variant_id;
    if found then v_unit_price := v_unit_price + coalesce(v_variant.price_adjustment, 0); end if;
  end if;

  v_delta := p_quantity - v_item.quantity;

  if v_delta <> 0 then
    select * into v_inv from public.store_item_inventory where store_item_id = v_item.store_item_id and variant_id is not distinct from v_item.store_item_variant_id for update;
    if found then
      if v_delta > 0 and (coalesce(v_inv.total_quantity,0) - coalesce(v_inv.reserved_quantity,0) - coalesce(v_inv.delivered_quantity,0) < v_delta) then
        raise exception using errcode='P0001', message='PRODUCT_OUT_OF_STOCK', detail=jsonb_build_object('code','PRODUCT_OUT_OF_STOCK','message',format('Estoque insuficiente para %s.', v_store_item.name))::text;
      end if;
      update public.store_item_inventory set reserved_quantity = greatest(reserved_quantity + v_delta, 0), updated_at = now() where id = v_inv.id;
    end if;
  end if;

  update public.order_items
    set quantity = p_quantity, unit_price = v_unit_price, final_amount = round(v_unit_price * p_quantity, 2), updated_at = now()
    where id = p_order_item_id;

  perform public.apply_cart_coupon(v_order.id, (select c.code from public.coupons c where c.id = v_order.applied_coupon_id));

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_product_quantity_changed', 'orders', v_order.id, v_order.event_id, jsonb_build_object('actor_user_id', v_actor, 'order_item_id', p_order_item_id, 'quantity', p_quantity, 'previous_quantity', v_item.quantity));

  return jsonb_build_object('order_id', v_order.id, 'order_item_id', p_order_item_id, 'quantity', p_quantity);
end; $$;

-- ============================================================
-- 3. apply_cart_coupon: subtotal/desconto por linha agora consideram
--    unit_price*quantity (era so unit_price, valido apenas enquanto toda
--    linha era 1 unidade). discount_amount/final_amount armazenados na
--    linha e no snapshot order_item_discounts passam a representar a linha
--    inteira (ex.: 3x R$60 com cupom de 20% => base_amount=180,
--    discount_amount=36), nao mais 1 unidade isolada.
-- ============================================================

create or replace function public.apply_cart_coupon(p_order_id uuid, p_coupon_code text)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_actor uuid := auth.uid();
  v_order public.orders%rowtype;
  v_coupon public.coupons%rowtype;
  v_code text := upper(trim(coalesce(p_coupon_code, '')));
  v_item record;
  v_line_subtotal numeric;
  v_eligible_subtotal numeric := 0;
  v_total_subtotal numeric := 0;
  v_total_discount numeric := 0;
  v_allocated numeric := 0;
  v_item_discount numeric;
  v_eligible_count integer := 0;
  v_now timestamptz := now();
  v_previous_coupon_id uuid;
  v_result jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;
  if v_order.status not in ('pending') then
    raise exception 'Pedido nao esta mais no carrinho (status atual: %).', v_order.status;
  end if;

  v_previous_coupon_id := v_order.applied_coupon_id;

  -- Sem codigo: limpa qualquer desconto/cupom aplicado.
  if v_code = '' then
    v_coupon.id := null;
  else
    select * into v_coupon from public.coupons where organization_id = v_order.organization_id and code = v_code for update;
    if not found then raise exception using errcode='P0001', message='COUPON_INVALID', detail=jsonb_build_object('code','COUPON_INVALID','message','Codigo de cupom invalido para esta organizacao.')::text; end if;
    if not v_coupon.is_active then raise exception using errcode='P0001', message='COUPON_INACTIVE', detail=jsonb_build_object('code','COUPON_INACTIVE','message','Cupom inativo.')::text; end if;
    if v_coupon.valid_from is not null and v_now < v_coupon.valid_from then raise exception using errcode='P0001', message='COUPON_NOT_YET_VALID', detail=jsonb_build_object('code','COUPON_NOT_YET_VALID','message','Cupom ainda nao esta vigente.')::text; end if;
    if v_coupon.valid_until is not null and v_now > v_coupon.valid_until then raise exception using errcode='P0001', message='COUPON_EXPIRED', detail=jsonb_build_object('code','COUPON_EXPIRED','message','Cupom expirado.')::text; end if;
    if v_coupon.max_uses is not null and v_coupon.used_count >= v_coupon.max_uses
      and v_previous_coupon_id is distinct from v_coupon.id then
      raise exception using errcode='P0001', message='COUPON_USES_EXHAUSTED', detail=jsonb_build_object('code','COUPON_USES_EXHAUSTED','message','Limite de usos do cupom atingido.')::text;
    end if;
  end if;

  -- Passo 1: elegibilidade e subtotal elegivel, olhando o carrinho REAL.
  for v_item in
    select id, item_kind, event_id, ticket_category_id, store_item_id, unit_price, quantity
    from public.order_items
    where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred')
    order by item_position nulls last, created_at, id
    for update
  loop
    v_line_subtotal := round(v_item.unit_price * coalesce(v_item.quantity, 1), 2);
    v_total_subtotal := v_total_subtotal + v_line_subtotal;
    if v_coupon.id is not null and public.is_order_item_eligible_for_coupon(v_coupon.id, v_item.item_kind, v_item.event_id, v_item.ticket_category_id, v_item.store_item_id) then
      v_eligible_subtotal := v_eligible_subtotal + v_line_subtotal;
      v_eligible_count := v_eligible_count + 1;
    end if;
  end loop;

  if v_coupon.id is not null and v_eligible_count = 0 then
    raise exception using errcode='P0001', message='COUPON_NO_ELIGIBLE_ITEMS', detail=jsonb_build_object('code','COUPON_NO_ELIGIBLE_ITEMS','message','Nenhum item do carrinho e elegivel para este cupom.')::text;
  end if;

  if v_coupon.id is not null then
    if v_coupon.discount_type = 'percentage' then
      v_total_discount := round(v_eligible_subtotal * v_coupon.discount_value / 100.0, 2);
    else
      v_total_discount := least(v_coupon.discount_value, v_eligible_subtotal);
    end if;
    v_total_discount := greatest(0, round(v_total_discount, 2));
  end if;

  -- Passo 2: distribui o desconto item a item (nunca sobre itens nao
  -- elegiveis, nunca gera total negativo). O ultimo item elegivel absorve o
  -- resto do arredondamento, garantindo soma exata.
  delete from public.order_item_discounts where order_item_id in (select id from public.order_items where order_id = p_order_id);
  v_allocated := 0;
  for v_item in
    select id, item_kind, event_id, ticket_category_id, store_item_id, unit_price, quantity,
      row_number() over (order by item_position nulls last, created_at, id) as rn,
      count(*) over () as total_rows
    from public.order_items
    where order_id = p_order_id and status not in ('cancelled','expired','refunded','transferred')
  loop
    v_line_subtotal := round(v_item.unit_price * coalesce(v_item.quantity, 1), 2);
    v_item_discount := 0;
    if v_coupon.id is not null and v_eligible_subtotal > 0
      and public.is_order_item_eligible_for_coupon(v_coupon.id, v_item.item_kind, v_item.event_id, v_item.ticket_category_id, v_item.store_item_id) then
      if v_item.rn = v_item.total_rows then
        v_item_discount := v_total_discount - v_allocated;
      else
        v_item_discount := round(v_line_subtotal / v_eligible_subtotal * v_total_discount, 2);
      end if;
      v_item_discount := greatest(0, least(v_item_discount, v_line_subtotal));
      v_allocated := v_allocated + v_item_discount;
    end if;

    update public.order_items
    set discount_amount = v_item_discount, final_amount = round(v_line_subtotal - v_item_discount, 2), updated_at = now()
    where id = v_item.id;

    if v_item_discount > 0 then
      insert into public.order_item_discounts(order_item_id, coupon_id, coupon_code, discount_type, discount_value, base_amount, discount_amount, final_amount)
      values (v_item.id, v_coupon.id, v_coupon.code, v_coupon.discount_type, v_coupon.discount_value, v_line_subtotal, v_item_discount, round(v_line_subtotal - v_item_discount, 2));
    end if;
  end loop;

  -- Passo 3: used_count so muda quando o cupom REALMENTE muda neste pedido
  -- (nao a cada recalculo do mesmo cupom apos add/remove de item).
  if v_previous_coupon_id is not null and v_previous_coupon_id is distinct from v_coupon.id then
    update public.coupons set used_count = greatest(used_count - 1, 0), updated_at = now() where id = v_previous_coupon_id;
  end if;
  if v_coupon.id is not null and v_previous_coupon_id is distinct from v_coupon.id then
    update public.coupons set used_count = used_count + 1, updated_at = now() where id = v_coupon.id;
  end if;

  update public.orders set applied_coupon_id = v_coupon.id, base_amount = v_total_subtotal,
    discount_amount = v_allocated, final_amount = round(v_total_subtotal - v_allocated, 2)
  where id = p_order_id;

  update public.payments set amount = v_total_subtotal, discount_amount = v_allocated,
    final_amount = round(v_total_subtotal - v_allocated, 2), updated_at = now()
  where order_id = p_order_id and payment_status = 'pending';

  insert into public.audit_logs(action, entity_type, entity_id, event_id, details)
  values('cart_coupon_applied', 'orders', p_order_id, v_order.event_id, jsonb_build_object(
    'actor_user_id', v_actor, 'coupon_id', v_coupon.id, 'coupon_code', nullif(v_code,''),
    'eligible_subtotal', v_eligible_subtotal, 'total_subtotal', v_total_subtotal, 'discount_amount', v_allocated));

  select jsonb_build_object(
    'order_id', p_order_id, 'coupon_id', v_coupon.id, 'coupon_code', nullif(v_code,''),
    'base_amount', v_total_subtotal, 'eligible_subtotal', v_eligible_subtotal,
    'discount_amount', v_allocated, 'final_amount', round(v_total_subtotal - v_allocated, 2)
  ) into v_result;
  return v_result;
end; $$;

-- ============================================================
-- 4. get_cart_order_details: expoe quantity por linha (faltava -- o client
--    nao tinha como saber quantas unidades uma linha representa).
-- ============================================================

create or replace function public.get_cart_order_details(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_actor uuid := auth.uid(); v_order public.orders%rowtype; v_items jsonb;
begin
  if v_actor is null then raise exception 'Usuario nao autenticado.'; end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido nao encontrado.'; end if;
  if not (v_order.user_id = v_actor or public.user_can_access_organization(v_actor, v_order.organization_id)) then
    raise exception 'Sem acesso a este pedido.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'order_item_id', oi.id, 'item_kind', oi.item_kind, 'status', oi.status, 'quantity', oi.quantity,
    'unit_price', oi.unit_price, 'discount_amount', oi.discount_amount, 'final_amount', oi.final_amount,
    'ticket_category_id', oi.ticket_category_id, 'category_name', tc.name,
    'shirt_type', oi.shirt_type, 'shirt_size', oi.shirt_size, 'holder_full_name', oi.holder_full_name,
    'store_item_id', oi.store_item_id, 'store_item_name', si.name,
    'store_item_image_url', (select sii.image_url from public.store_item_images sii where sii.store_item_id = si.id and sii.is_primary limit 1),
    'store_item_variant_id', oi.store_item_variant_id, 'variant_name', siv.name, 'variant_value', siv.value
  ) order by oi.item_kind, oi.item_position nulls last, oi.created_at), '[]'::jsonb)
  into v_items
  from public.order_items oi
  left join public.ticket_categories tc on tc.id = oi.ticket_category_id
  left join public.store_items si on si.id = oi.store_item_id
  left join public.store_item_variants siv on siv.id = oi.store_item_variant_id
  where oi.order_id = p_order_id and oi.status not in ('cancelled','expired','refunded','transferred');

  return jsonb_build_object(
    'order_id', v_order.id, 'event_id', v_order.event_id, 'status', v_order.status,
    'base_amount', v_order.base_amount, 'discount_amount', v_order.discount_amount, 'final_amount', v_order.final_amount,
    'applied_coupon_id', v_order.applied_coupon_id,
    'applied_coupon_code', (select code from public.coupons where id = v_order.applied_coupon_id),
    'items', v_items
  );
end; $$;

revoke all on function public.set_cart_order_item_quantity(uuid,integer) from public,anon;
grant execute on function public.set_cart_order_item_quantity(uuid,integer) to authenticated,service_role;

commit;
